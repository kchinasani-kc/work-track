import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA_VERSION = 2;

// All timestamps are UTC epoch milliseconds.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- People are identified by their git email. Team members are created automatically
-- the first time their Claude Code reports work; managers also get a dashboard password.
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'manager')),
  active        INTEGER NOT NULL DEFAULT 1,
  name_locked   INTEGER NOT NULL DEFAULT 0,  -- 1 once a manager renames them; git name no longer overrides
  password_hash TEXT,
  last_seen_at  INTEGER,
  last_app      TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,           -- sha256 of the cookie value
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- Statuses are referenced by id everywhere, so renaming one never rewrites history.
-- They are archived, never deleted, because task_events point at them.
CREATE TABLE IF NOT EXISTS statuses (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color            TEXT NOT NULL DEFAULT '#64748b',
  category         TEXT NOT NULL CHECK (category IN ('todo', 'active', 'blocked', 'done')),
  position         INTEGER NOT NULL,
  stuck_after_days REAL,                 -- NULL = use default, 0 = never flag as stuck
  archived         INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

-- One row per Jira ticket someone has worked on in Claude Code. Title and description
-- are copied from Jira (read-only); status and work summary belong to the tracker.
CREATE TABLE IF NOT EXISTS tasks (
  id                 INTEGER PRIMARY KEY,
  jira_key           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  title              TEXT,
  description        TEXT NOT NULL DEFAULT '',
  details_source     TEXT,               -- 'jira' | 'claude' | NULL (not loaded yet)
  details_fetched_at INTEGER,
  details_error      TEXT,
  work_summary       TEXT,
  summary_updated_at INTEGER,
  assignee_id        INTEGER REFERENCES users(id),
  status_id          INTEGER NOT NULL REFERENCES statuses(id),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  status_changed_at  INTEGER NOT NULL,
  closed_at          INTEGER,
  last_activity_at   INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status_id);

-- Append-only log. A 'created' event carries the initial status so time in the
-- first status can be measured; every later status change is a 'status' event.
CREATE TABLE IF NOT EXISTS task_events (
  id             INTEGER PRIMARY KEY,
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('created', 'status', 'assigned', 'comment', 'summary')),
  from_status_id INTEGER REFERENCES statuses(id),
  to_status_id   INTEGER REFERENCES statuses(id),
  from_user_id   INTEGER REFERENCES users(id),
  to_user_id     INTEGER REFERENCES users(id),
  actor_id       INTEGER REFERENCES users(id),
  source         TEXT NOT NULL CHECK (source IN ('claude', 'hook', 'web', 'system')),
  note           TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id, created_at);

-- Claude Code sessions seen working on a ticket ("who is on it right now, in which app").
CREATE TABLE IF NOT EXISTS activity (
  id         INTEGER PRIMARY KEY,
  task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL,
  app        TEXT,
  app_raw    TEXT,
  repo       TEXT,
  branch     TEXT,
  first_at   INTEGER NOT NULL,
  last_at    INTEGER NOT NULL,
  pings      INTEGER NOT NULL DEFAULT 1,
  UNIQUE (session_id, task_id)
);
CREATE INDEX IF NOT EXISTS activity_task ON activity(task_id, last_at);
CREATE INDEX IF NOT EXISTS activity_user ON activity(user_id, last_at);
`;

const DEFAULT_STATUSES = [
  { name: 'To Do', color: '#64748b', category: 'todo', stuck_after_days: null },
  { name: 'In Progress', color: '#2563eb', category: 'active', stuck_after_days: null },
  { name: 'Blocked', color: '#dc2626', category: 'blocked', stuck_after_days: 1 },
  { name: 'In Review', color: '#7c3aed', category: 'active', stuck_after_days: 2 },
  { name: 'Done', color: '#16a34a', category: 'done', stuck_after_days: null },
];

const DEFAULT_SETTINGS = {
  default_stuck_days: '3',
  active_minutes: '30',      // a ticket counts as "being worked on now" this long after the last Claude activity
  jira_project_keys: '',     // comma-separated; empty = accept any KEY-123 found in a branch name
};

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new Error(
      `${file} was created by an older version of Work Tracker (schema ${version}). ` +
        'It only holds trial data from before the Jira switch: move it aside and start again.'
    );
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  seed(db);
  return db;
}

function seed(db) {
  const now = Date.now();
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);
  insertSetting.run('team_key', `wtk_${crypto.randomBytes(18).toString('base64url')}`);

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM statuses').get();
  if (n === 0) {
    const insert = db.prepare(
      'INSERT INTO statuses (name, color, category, position, stuck_after_days, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    DEFAULT_STATUSES.forEach((s, i) => insert.run(s.name, s.color, s.category, i + 1, s.stuck_after_days, now));
  }
}

/** Run fn inside a transaction; rolls back if it throws. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

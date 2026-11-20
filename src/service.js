import crypto from 'node:crypto';

export const CATEGORIES = ['todo', 'active', 'blocked', 'done'];
export const SOURCES = ['claude', 'hook', 'web', 'system'];

const DAY = 86_400_000;
const SESSION_TTL = 30 * DAY;
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;

export class AppError extends Error {
  constructor(message, status = 400, details = undefined) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// ---------- small helpers ----------

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_\-]+/g, '');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clean = (s) => (typeof s === 'string' ? s.trim() : s);

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function checkPassword(password, stored) {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function requireText(value, field, max = 500) {
  const v = clean(value);
  if (!v) throw new AppError(`${field} is required`);
  if (v.length > max) throw new AppError(`${field} must be at most ${max} characters`);
  return v;
}

function optionalText(value, field, max) {
  const v = clean(value);
  if (!v) return null;
  if (v.length > max) throw new AppError(`${field} must be at most ${max} characters`);
  return v;
}

function validColor(c) {
  if (!/^#[0-9a-fA-F]{6}$/.test(c)) throw new AppError('color must be a hex value like #2563eb');
  return c.toLowerCase();
}

/** Time in days ("3 days", "less than a day"): this is a status tracker, not a stopwatch. */
export function formatDuration(ms) {
  if (ms == null) return '';
  const d = Math.floor(ms / 86_400_000);
  if (d < 1) return 'less than a day';
  return d === 1 ? '1 day' : `${d} days`;
}


// ---------- tracker ----------

/**
 * Domain logic shared by the dashboard API and the Claude Code API. Every function that
 * touches the database is async. The acting person always comes from the caller's
 * session or git identity, never from free-form request fields.
 */
export function createTracker(db, { now = () => Date.now(), jiraBaseUrl = null } = {}) {
  // ---- settings ----
  // Not cached: on Vercel several instances run at once, and they must agree on the team key
  // and project list as soon as a manager changes them.
  async function getSettings() {
    const rows = await db.all('SELECT key, value FROM wt.settings');
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return {
      default_stuck_days: Number(s.default_stuck_days),
      jira_project_keys: (s.jira_project_keys || '').split(',').map((k) => k.trim()).filter(Boolean),
      team_key: s.team_key,
    };
  }

  async function setSetting(key, value) {
    await db.run('UPDATE wt.settings SET value = ? WHERE key = ?', value, key);
  }

  async function updateSettings(patch) {
    if (patch.default_stuck_days !== undefined) {
      const d = Number(patch.default_stuck_days);
      if (!Number.isFinite(d) || d < 0) throw new AppError('default stuck days must be 0 or more');
      await setSetting('default_stuck_days', String(d));
    }
    if (patch.jira_project_keys !== undefined) {
      const raw = Array.isArray(patch.jira_project_keys) ? patch.jira_project_keys : String(patch.jira_project_keys).split(',');
      const keys = [...new Set(raw.map((k) => String(k).trim().toUpperCase()).filter(Boolean))];
      for (const k of keys) if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new AppError(`"${k}" is not a Jira project key`);
      await setSetting('jira_project_keys', keys.join(','));
    }
    return getSettings();
  }

  async function regenerateTeamKey() {
    const key = `wtk_${crypto.randomBytes(18).toString('base64url')}`;
    await setSetting('team_key', key);
    return key;
  }

  async function checkTeamKey(key) {
    const expected = Buffer.from((await getSettings()).team_key ?? '');
    const given = Buffer.from(String(key ?? ''));
    return expected.length > 0 && given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  // ---- people ----
  const userCols = (p = '') =>
    `${p}id, ${p}name, ${p}email, ${p}role, ${p}active, ${p}name_locked, ${p}created_at, ${p}password_hash IS NOT NULL AS has_password`;
  const USER_COLS = userCols();

  async function getUser(id) {
    const u = await db.get(`SELECT ${USER_COLS} FROM wt.users WHERE id = ?`, id);
    if (!u) throw new AppError('person not found', 404);
    return u;
  }

  async function listUsers() {
    return db.all(
      `SELECT ${userCols('u.')},
         (SELECT COUNT(*) FROM wt.tasks t JOIN wt.statuses s ON s.id = t.status_id
            WHERE t.assignee_id = u.id AND s.category != 'done') AS open_tasks
       FROM wt.users u ORDER BY u.active DESC, lower(u.name)`
    );
  }

  function validEmail(email) {
    const e = clean(email);
    if (!e || !/^[^\s@]+@[^\s@]+$/.test(e) || e.length > 200) {
      throw new AppError('a git email is required (set it with: git config --global user.email you@company.com)', 400);
    }
    return e.toLowerCase();
  }

  /** Find or create the person behind a git identity. Safe when two requests race. */
  async function upsertPerson({ email, name }) {
    const e = validEmail(email);
    const n = optionalText(name, 'name', 100);
    let row = await db.get('SELECT * FROM wt.users WHERE email = ?', e);
    if (!row) {
      await db.run(
        "INSERT INTO wt.users (name, email, role, created_at) VALUES (?, ?, 'member', ?) ON CONFLICT (email) DO NOTHING",
        n || e.split('@')[0], e, now()
      );
      row = await db.get('SELECT * FROM wt.users WHERE email = ?', e);
    }
    if (!row.active) throw new AppError(`${e} has been deactivated in Work Tracker`, 403);
    if (n && !row.name_locked && n !== row.name) await db.run('UPDATE wt.users SET name = ? WHERE id = ?', n, row.id);
    return getUser(row.id);
  }

  async function createManager({ name, email, password }) {
    const e = validEmail(email);
    const n = requireText(name, 'name', 100);
    if (!password || String(password).length < 8) throw new AppError('password must be at least 8 characters');
    const existing = await db.get('SELECT id FROM wt.users WHERE email = ?', e);
    if (existing) {
      await db.run("UPDATE wt.users SET role = 'manager', active = 1, password_hash = ? WHERE id = ?", hashPassword(String(password)), existing.id);
      return getUser(existing.id);
    }
    const r = await db.get(
      "INSERT INTO wt.users (name, email, role, password_hash, name_locked, created_at) VALUES (?, ?, 'manager', ?, 1, ?) RETURNING id",
      n, e, hashPassword(String(password)), now()
    );
    return getUser(r.id);
  }

  async function updateUser(id, patch) {
    const u = await getUser(id);
    const name = patch.name !== undefined ? requireText(patch.name, 'name', 100) : u.name;
    const role = patch.role ?? u.role;
    const active = patch.active !== undefined ? (patch.active ? 1 : 0) : u.active;
    if (!['member', 'manager'].includes(role)) throw new AppError('role must be member or manager');
    if ((role !== 'manager' || !active) && u.role === 'manager' && u.active && u.has_password) {
      const { n } = await db.get(
        "SELECT COUNT(*) AS n FROM wt.users WHERE role = 'manager' AND active = 1 AND password_hash IS NOT NULL AND id != ?",
        id
      );
      if (n === 0) throw new AppError('this is the last manager who can sign in; add another manager first', 409);
    }
    await db.run('UPDATE wt.users SET name = ?, role = ?, active = ?, name_locked = ? WHERE id = ?',
      name, role, active, name !== u.name ? 1 : u.name_locked, id);
    if (!active || role !== 'manager') await db.run('DELETE FROM wt.sessions WHERE user_id = ?', id);
    return getUser(id);
  }

  async function setPassword(id, password) {
    const u = await getUser(id);
    if (!password || String(password).length < 8) throw new AppError('password must be at least 8 characters');
    if (u.role !== 'manager') throw new AppError('only managers sign in to the dashboard');
    await db.run('UPDATE wt.users SET password_hash = ? WHERE id = ?', hashPassword(String(password)), id);
    await db.run('DELETE FROM wt.sessions WHERE user_id = ?', id);
  }

  async function hasManager() {
    return !!(await db.get("SELECT 1 AS x FROM wt.users WHERE role = 'manager' AND active = 1 AND password_hash IS NOT NULL LIMIT 1"));
  }

  async function login(email, password) {
    const row = await db.get(
      "SELECT id, password_hash FROM wt.users WHERE email = ? AND active = 1 AND role = 'manager'",
      String(clean(email) ?? '').toLowerCase()
    );
    if (!row || !checkPassword(String(password ?? ''), row.password_hash)) {
      if (!(await hasManager())) {
        throw new AppError('No manager account exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD on the server and restart (or redeploy).', 401);
      }
      throw new AppError('wrong email or password', 401);
    }
    const sid = crypto.randomBytes(32).toString('base64url');
    await db.run('DELETE FROM wt.sessions WHERE expires_at < ?', now());
    await db.run('INSERT INTO wt.sessions (id, user_id, expires_at) VALUES (?, ?, ?)', sha256(sid), row.id, now() + SESSION_TTL);
    return { sid, user: await getUser(row.id), maxAgeMs: SESSION_TTL };
  }

  async function sessionUser(sid) {
    if (!sid) return null;
    return (
      (await db.get(
        `SELECT ${userCols('u.')}
         FROM wt.sessions s JOIN wt.users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ? AND u.active = 1 AND u.role = 'manager'`,
        sha256(sid), now()
      )) ?? null
    );
  }

  async function logout(sid) {
    if (sid) await db.run('DELETE FROM wt.sessions WHERE id = ?', sha256(sid));
  }

  /**
   * Ensure at least one manager can sign in. Uses the given password, or generates one only
   * when allowed (local runs, where it can be printed). Returns credentials if one was created.
   */
  async function ensureManager({ email = 'admin@localhost', password, allowGenerated = false } = {}) {
    if (await hasManager()) return null;
    if (!password && !allowGenerated) return null;
    const pw = password || crypto.randomBytes(9).toString('base64url');
    await createManager({ name: 'Manager', email, password: pw });
    return { email: email.toLowerCase(), password: pw, generated: !password };
  }

  // ---- statuses ----
  function effectiveStuckDays(status, settings) {
    if (status.category === 'done') return 0;
    if (status.stuck_after_days == null) return settings.default_stuck_days || 0;
    return status.stuck_after_days;
  }

  async function listStatuses({ includeArchived = true } = {}) {
    const settings = await getSettings();
    const rows = await db.all(
      `SELECT s.*, (SELECT COUNT(*) FROM wt.tasks t WHERE t.status_id = s.id) AS task_count
       FROM wt.statuses s ${includeArchived ? '' : 'WHERE s.archived = 0'}
       ORDER BY s.archived, s.position, s.id`
    );
    return rows.map((s) => ({ ...s, effective_stuck_days: effectiveStuckDays(s, settings) }));
  }

  async function getStatus(id) {
    const s = await db.get('SELECT * FROM wt.statuses WHERE id = ?', id);
    if (!s) throw new AppError('status not found', 404);
    return s;
  }

  async function resolveStatus(ref) {
    const all = await db.all('SELECT * FROM wt.statuses WHERE archived = 0 ORDER BY position');
    const valid = () => all.map((s) => `"${s.name}" (${s.category})`).join(', ');
    if (ref == null || ref === '') throw new AppError(`status is required. Valid statuses: ${valid()}`);
    if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
      const byId = all.find((s) => s.id === Number(ref));
      if (byId) return byId;
    }
    const n = norm(ref);
    const match = all.find((s) => norm(s.name) === n);
    if (match) return match;
    throw new AppError(`unknown status "${ref}". Valid statuses: ${valid()}`, 400, { valid_statuses: all.map((s) => s.name) });
  }

  function parseStuckDays(v) {
    if (v === undefined) return undefined;
    if (v === null || v === '') return null;
    const d = Number(v);
    if (!Number.isFinite(d) || d < 0) throw new AppError('stuck after days must be empty or 0 or more');
    return d;
  }

  async function nameTaken(name, exceptId = 0) {
    return !!(await db.get('SELECT 1 AS x FROM wt.statuses WHERE lower(name) = lower(?) AND id != ?', name, exceptId));
  }

  async function createStatus({ name, color = '#64748b', category = 'active', stuck_after_days = null }) {
    name = requireText(name, 'status name', 40);
    if (!CATEGORIES.includes(category)) throw new AppError(`category must be one of ${CATEGORIES.join(', ')}`);
    if (await nameTaken(name)) throw new AppError(`a status named "${name}" already exists`, 409);
    const { p } = await db.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM wt.statuses');
    const r = await db.get(
      'INSERT INTO wt.statuses (name, color, category, position, stuck_after_days, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      name, validColor(color), category, p, parseStuckDays(stuck_after_days) ?? null, now()
    );
    return getStatus(r.id);
  }

  async function updateStatus(id, patch) {
    const s = await getStatus(id);
    const name = patch.name !== undefined ? requireText(patch.name, 'status name', 40) : s.name;
    const color = patch.color !== undefined ? validColor(patch.color) : s.color;
    const category = patch.category ?? s.category;
    const stuck = patch.stuck_after_days !== undefined ? parseStuckDays(patch.stuck_after_days) : s.stuck_after_days;
    const archived = patch.archived !== undefined ? (patch.archived ? 1 : 0) : s.archived;
    if (!CATEGORIES.includes(category)) throw new AppError(`category must be one of ${CATEGORIES.join(', ')}`);
    if (await nameTaken(name, id)) throw new AppError(`a status named "${name}" already exists`, 409);
    if (archived && !s.archived) throw new AppError('use the archive action so tickets in this status can be moved');
    await db.tx(async () => {
      await db.run('UPDATE wt.statuses SET name = ?, color = ?, category = ?, stuck_after_days = ?, archived = ? WHERE id = ?',
        name, color, category, stuck, archived, id);
      // Keep closed_at consistent if a status moves in or out of the done category.
      if (category !== s.category) {
        if (category === 'done') await db.run('UPDATE wt.tasks SET closed_at = COALESCE(closed_at, status_changed_at) WHERE status_id = ?', id);
        else await db.run('UPDATE wt.tasks SET closed_at = NULL WHERE status_id = ?', id);
      }
    });
    return getStatus(id);
  }

  async function reorderStatuses(ids) {
    if (!Array.isArray(ids) || ids.length === 0) throw new AppError('ids must be a non-empty list');
    await db.tx(async () => {
      for (const [i, id] of ids.entries()) await db.run('UPDATE wt.statuses SET position = ? WHERE id = ?', i + 1, Number(id));
    });
    return listStatuses();
  }

  async function archiveStatus(id, { moveTo } = {}, actor) {
    const s = await getStatus(id);
    if (s.archived) return s;
    const { n: remaining } = await db.get('SELECT COUNT(*) AS n FROM wt.statuses WHERE archived = 0 AND id != ?', id);
    if (remaining === 0) throw new AppError('you need at least one status');
    const tasks = await db.all('SELECT id FROM wt.tasks WHERE status_id = ?', id);
    if (tasks.length && moveTo == null) {
      throw new AppError(`${tasks.length} ticket(s) are in "${s.name}". Choose a status to move them to.`, 409, { task_count: tasks.length });
    }
    await db.tx(async () => {
      if (tasks.length) {
        const target = await getStatus(Number(moveTo));
        if (target.archived || target.id === s.id) throw new AppError('pick an active status to move tickets to');
        for (const t of tasks) await moveStatus(t.id, target, `Moved because status "${s.name}" was archived`, actor, 'web');
      }
      await db.run('UPDATE wt.statuses SET archived = 1 WHERE id = ?', id);
    });
    return getStatus(id);
  }

  /** Status a ticket gets when someone starts working on it: the first active status. */
  async function startStatus() {
    return (
      (await db.get("SELECT * FROM wt.statuses WHERE archived = 0 AND category = 'active' ORDER BY position LIMIT 1")) ??
      (await db.get('SELECT * FROM wt.statuses WHERE archived = 0 ORDER BY position LIMIT 1'))
    );
  }

  // ---- tickets ----

  /** Validate a Jira key and check it belongs to a tracked project. */
  async function normalizeKey(ref, { strictCase = false } = {}) {
    const raw = String(ref ?? '').trim();
    const k = raw.toUpperCase();
    if (!KEY_RE.test(k)) throw new AppError(`"${ref}" is not a Jira ticket key like PROJ-123`);
    const allowed = (await getSettings()).jira_project_keys;
    if (allowed.length && !allowed.includes(k.split('-')[0])) {
      throw new AppError(`${k} is not in a tracked Jira project (${allowed.join(', ')})`, 422);
    }
    // Without a project list, a lowercase match in a branch name (e.g. lodash-4) is too likely to be noise.
    if (strictCase && !allowed.length && raw !== k) {
      throw new AppError(`${raw} isn't uppercase; set "Jira projects to track" to accept lowercase branch names`, 422);
    }
    return k;
  }

  async function findTaskId(ref) {
    const q = String(ref ?? '').trim();
    if (!q) throw new AppError('ticket is required');
    const row = await db.get('SELECT id FROM wt.tasks WHERE jira_key = ?', q.toUpperCase());
    if (row) return row.id;
    throw new AppError(
      `${q.toUpperCase()} isn't in the tracker yet. It is added when someone works on it in Claude Code (on a branch named with the key), or with start_ticket.`,
      404
    );
  }

  async function insertEvent(e) {
    await db.run(
      `INSERT INTO wt.task_events (task_id, kind, from_status_id, to_status_id, from_user_id, to_user_id, actor_id, source, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.task_id, e.kind, e.from_status_id ?? null, e.to_status_id ?? null, e.from_user_id ?? null, e.to_user_id ?? null,
      e.actor_id ?? null, e.source, e.note ?? null, e.created_at ?? now()
    );
  }

  function checkSource(source) {
    if (!SOURCES.includes(source)) throw new AppError('bad source');
  }

  /** Inner status move; the caller provides the transaction. Locks the row to serialise moves. */
  async function moveStatus(taskId, status, note, actor, source) {
    const task = await db.get('SELECT * FROM wt.tasks WHERE id = ? FOR UPDATE', taskId);
    if (task.status_id === status.id) return false;
    const t = now();
    await db.run('UPDATE wt.tasks SET status_id = ?, status_changed_at = ?, updated_at = ?, closed_at = ? WHERE id = ?',
      status.id, t, t, status.category === 'done' ? t : null, taskId);
    await insertEvent({ task_id: taskId, kind: 'status', from_status_id: task.status_id, to_status_id: status.id, actor_id: actor?.id, source, note: clean(note) || null, created_at: t });
    return true;
  }

  /**
   * Someone started (or resumed) work on a ticket: a Claude Code session began on its branch,
   * or Claude called start_ticket. The first time, the ticket is added in the first active status
   * so its clock starts. Nothing else is recorded about the session: no app, no prompt activity,
   * no last-seen time. Two first reports can arrive at the same moment (separate serverless
   * invocations), so creation is an INSERT ... ON CONFLICT.
   */
  async function recordActivity({ person, ticket, event, sessionSource }, source = 'hook') {
    checkSource(source);
    const key = await normalizeKey(ticket, { strictCase: source === 'hook' });
    const user = await upsertPerson(person);
    // A ticket parked in a to-do status only restarts when a new session begins on it (or the
    // person says they're on it via start_ticket), not when the session that parked it carries on.
    const resumes = source === 'claude' || (event === 'SessionStart' && sessionSource !== 'compact');
    const t = now();

    const result = await db.tx(async () => {
      const start = await startStatus();
      const inserted = await db.get(
        `INSERT INTO wt.tasks (jira_key, assignee_id, status_id, created_at, updated_at, status_changed_at, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (jira_key) DO NOTHING RETURNING id`,
        key, user.id, start.id, t, t, t, start.category === 'done' ? t : null
      );
      let id;
      if (inserted) {
        id = inserted.id;
        await insertEvent({ task_id: id, kind: 'created', to_status_id: start.id, to_user_id: user.id, actor_id: user.id, source, note: 'Started in Claude Code', created_at: t });
        // Details captured when the ticket was loaded from Jira before work started.
        await db.run(
          `UPDATE wt.tasks t SET title = c.title, description = c.description, details_source = c.source, details_fetched_at = c.fetched_at
           FROM wt.jira_details c WHERE t.id = ? AND c.jira_key = t.jira_key`,
          id
        );
      } else {
        const task = await db.get('SELECT * FROM wt.tasks WHERE jira_key = ? FOR UPDATE', key);
        id = task.id;
        if (task.assignee_id !== user.id) {
          await db.run('UPDATE wt.tasks SET assignee_id = ?, updated_at = ? WHERE id = ?', user.id, t, id);
          await insertEvent({ task_id: id, kind: 'assigned', from_user_id: task.assignee_id, to_user_id: user.id, actor_id: user.id, source, note: 'Picked up', created_at: t });
        }
        const current = await getStatus(task.status_id);
        if (current.category === 'todo' && resumes) await moveStatus(id, start, 'Work resumed', user, source);
      }
      return { id, created: !!inserted };
    });
    return { created: result.created, person: await getUser(user.id), task: await getTask(result.id) };
  }

  /**
   * Title/description from Jira ('jira': the server's own lookup or a captured Jira response)
   * or supplied by Claude ('claude'). Jira wins over Claude. A ticket that isn't tracked yet
   * (e.g. fetched by the pickup skill before its branch exists) is remembered and applied when
   * work on it starts. Leaving description undefined keeps the existing one.
   */
  async function setDetails(ref, { title, description, error }, source) {
    const key = String(ref ?? '').trim().toUpperCase();
    const id = await db.get('SELECT id FROM wt.tasks WHERE jira_key = ?', key).then((r) => r?.id);
    if (error) {
      if (!id) return null;
      await db.run('UPDATE wt.tasks SET details_error = ?, details_fetched_at = ? WHERE id = ?', String(error).slice(0, 300), now(), id);
      return getTask(id);
    }
    const src = source === 'jira' ? 'jira' : 'claude';
    const t = requireText(title, 'title', 500);
    const d = description === undefined ? undefined : (clean(description ?? '') || '').slice(0, 50000);
    const cached = await db.get('SELECT source FROM wt.jira_details WHERE jira_key = ?', key);
    if (!(src === 'claude' && cached?.source === 'jira')) {
      await db.run(
        `INSERT INTO wt.jira_details (jira_key, title, description, source, fetched_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (jira_key) DO UPDATE SET title = EXCLUDED.title,
           description = CASE WHEN ?::boolean THEN wt.jira_details.description ELSE EXCLUDED.description END,
           source = EXCLUDED.source, fetched_at = EXCLUDED.fetched_at`,
        await normalizeKey(key), t, d ?? '', src, now(), d === undefined
      );
    }
    if (!id) return null;
    const task = await db.get('SELECT details_source FROM wt.tasks WHERE id = ?', id);
    if (src === 'claude' && task.details_source === 'jira') return getTask(id); // Jira wins
    if (d === undefined) {
      await db.run('UPDATE wt.tasks SET title = ?, details_source = ?, details_fetched_at = ?, details_error = NULL WHERE id = ?', t, src, now(), id);
    } else {
      await db.run(
        'UPDATE wt.tasks SET title = ?, description = ?, details_source = ?, details_fetched_at = ?, details_error = NULL WHERE id = ?',
        t, d, src, now(), id
      );
    }
    return getTask(id);
  }

  async function needsDetails(ref, maxAgeMs = 6 * 3_600_000) {
    const id = await findTaskId(ref);
    const t = await db.get('SELECT title, details_source, details_fetched_at FROM wt.tasks WHERE id = ?', id);
    if (!t.title || t.details_source !== 'jira') return true;
    return now() - (t.details_fetched_at ?? 0) > maxAgeMs;
  }

  async function saveSummary(id, summary, actor, source) {
    const t = now();
    await db.run('UPDATE wt.tasks SET work_summary = ?, summary_updated_at = ?, updated_at = ? WHERE id = ?', summary, t, t, id);
    await insertEvent({ task_id: id, kind: 'summary', actor_id: actor?.id, source, note: summary, created_at: t });
  }

  async function changeStatus(ref, statusRef, { note, summary } = {}, actor, source) {
    checkSource(source);
    const id = await findTaskId(ref);
    const status = await resolveStatus(statusRef);
    const sum = optionalText(summary, 'summary', 5000);
    if (status.category === 'done' && source === 'claude' && !sum) {
      throw new AppError(`Moving to "${status.name}" needs a short summary of the work done. Pass it as summary.`);
    }
    const before = await db.get('SELECT status_id, status_changed_at FROM wt.tasks WHERE id = ?', id);
    const changed = await db.tx(async () => {
      const moved = await moveStatus(id, status, note, actor, source);
      if (sum) await saveSummary(id, sum, actor, source);
      if (!moved && clean(note)) await insertEvent({ task_id: id, kind: 'comment', actor_id: actor?.id, source, note: clean(note) });
      return moved;
    });
    return {
      changed,
      previous_status: (await getStatus(before.status_id)).name,
      time_in_previous_ms: changed ? now() - before.status_changed_at : null,
      task: await getTask(id),
    };
  }

  async function setSummary(ref, summary, actor, source) {
    checkSource(source);
    const id = await findTaskId(ref);
    const text = requireText(summary, 'summary', 5000);
    await db.tx(() => saveSummary(id, text, actor, source));
    return getTask(id);
  }

  async function addComment(ref, note, actor, source) {
    checkSource(source);
    const id = await findTaskId(ref);
    const text = requireText(note, 'note', 5000);
    await db.tx(async () => {
      await insertEvent({ task_id: id, kind: 'comment', actor_id: actor?.id, source, note: text });
      await db.run('UPDATE wt.tasks SET updated_at = ? WHERE id = ?', now(), id);
    });
    return getTask(id);
  }

  async function deleteTask(ref) {
    const id = await findTaskId(ref);
    await db.run('DELETE FROM wt.tasks WHERE id = ?', id);
    return { deleted: true };
  }

  const TASK_SELECT = `
    SELECT t.*, s.name AS status_name, s.color AS status_color, s.category AS status_category,
           s.stuck_after_days AS status_stuck_after_days,
           u.name AS assignee_name, u.email AS assignee_email,
           (SELECT e.source FROM wt.task_events e WHERE e.task_id = t.id ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_source
    FROM wt.tasks t
    JOIN wt.statuses s ON s.id = t.status_id
    LEFT JOIN wt.users u ON u.id = t.assignee_id`;

  function enrich(row, settings) {
    const t = now();
    const inStatus = t - row.status_changed_at;
    const stuckDays = effectiveStuckDays({ category: row.status_category, stuck_after_days: row.status_stuck_after_days }, settings);
    return {
      id: row.id,
      key: row.jira_key,
      title: row.title,
      description: row.description,
      details_source: row.details_source,
      details_error: row.details_error,
      jira_url: jiraBaseUrl ? `${jiraBaseUrl.replace(/\/+$/, '')}/browse/${row.jira_key}` : null,
      work_summary: row.work_summary,
      summary_updated_at: row.summary_updated_at,
      status: { id: row.status_id, name: row.status_name, color: row.status_color, category: row.status_category },
      assignee: row.assignee_id ? { id: row.assignee_id, name: row.assignee_name, email: row.assignee_email } : null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      status_changed_at: row.status_changed_at,
      closed_at: row.closed_at,
      time_in_status_ms: inStatus,
      stuck_after_days: stuckDays,
      stuck: stuckDays > 0 && inStatus > stuckDays * DAY,
      last_source: row.last_source,
    };
  }

  async function listTasks({ assigneeId, statusId, includeDone = false, doneWithinDays, q, limit = 1000 } = {}) {
    const where = [];
    const args = [];
    if (assigneeId === 'none') where.push('t.assignee_id IS NULL');
    else if (assigneeId != null && assigneeId !== '') {
      where.push('t.assignee_id = ?');
      args.push(Number(assigneeId));
    }
    if (statusId != null && statusId !== '') {
      where.push('t.status_id = ?');
      args.push(Number(statusId));
    }
    if (!includeDone) where.push("s.category != 'done'");
    else if (doneWithinDays) {
      where.push("(s.category != 'done' OR t.closed_at >= ?)");
      args.push(now() - doneWithinDays * DAY);
    }
    if (q) {
      where.push('(t.jira_key ILIKE ? OR t.title ILIKE ? OR t.description ILIKE ? OR t.work_summary ILIKE ?)');
      const like = `%${String(q).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      args.push(like, like, like, like);
    }
    const settings = await getSettings();
    const rows = await db.all(
      `${TASK_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.status_changed_at ASC LIMIT ?`,
      ...args, Math.min(Number(limit) || 1000, 5000)
    );
    return rows.map((r) => enrich(r, settings));
  }

  async function getTask(ref) {
    const id = typeof ref === 'number' ? ref : await findTaskId(ref);
    const row = await db.get(`${TASK_SELECT} WHERE t.id = ?`, id);
    if (!row) throw new AppError('ticket not found', 404);
    const task = enrich(row, await getSettings());
    const events = await db.all(
      `SELECT e.*, a.name AS actor_name, fs.name AS from_status_name, ts.name AS to_status_name,
              ts.color AS to_status_color, fu.name AS from_user_name, tu.name AS to_user_name
       FROM wt.task_events e
       LEFT JOIN wt.users a ON a.id = e.actor_id
       LEFT JOIN wt.statuses fs ON fs.id = e.from_status_id
       LEFT JOIN wt.statuses ts ON ts.id = e.to_status_id
       LEFT JOIN wt.users fu ON fu.id = e.from_user_id
       LEFT JOIN wt.users tu ON tu.id = e.to_user_id
       WHERE e.task_id = ? ORDER BY e.created_at, e.id`,
      id
    );
    task.events = events;
    task.time_by_status = timeByStatus(events);
    return task;
  }

  /** Total time spent in each status, from the event log. */
  function timeByStatus(events) {
    const out = new Map();
    const moves = events.filter((e) => e.kind === 'created' || e.kind === 'status');
    moves.forEach((e, i) => {
      const end = i + 1 < moves.length ? moves[i + 1].created_at : now();
      const cur = out.get(e.to_status_id) ?? { status_id: e.to_status_id, name: e.to_status_name, color: e.to_status_color, total_ms: 0, visits: 0, current: false };
      cur.total_ms += end - e.created_at;
      cur.visits += 1;
      if (i + 1 === moves.length) cur.current = true;
      out.set(e.to_status_id, cur);
    });
    return [...out.values()];
  }

  // ---- reports ----

  /** Every stint a ticket spent in a status: { task_id, status_id, assignee_id, start, end|null }. */
  async function allStints() {
    const rows = await db.all(
      `SELECT e.task_id, e.to_status_id, e.created_at, t.assignee_id
       FROM wt.task_events e JOIN wt.tasks t ON t.id = e.task_id
       WHERE e.kind IN ('created', 'status')
       ORDER BY e.task_id, e.created_at, e.id`
    );
    const stints = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const next = rows[i + 1];
      const end = next && next.task_id === r.task_id ? next.created_at : null;
      stints.push({ task_id: r.task_id, status_id: r.to_status_id, assignee_id: r.assignee_id, start: r.created_at, end });
    }
    return stints;
  }

  async function teamSummary() {
    const statuses = await listStatuses({ includeArchived: false });
    const users = (await listUsers()).filter((u) => u.active);
    const tasks = await listTasks({ includeDone: true, doneWithinDays: 7 });
    const people = [
      ...users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })),
      { id: null, name: 'Unassigned' },
    ];
    const t = now();
    const result = people.map((p) => {
      const mine = tasks.filter((x) => (x.assignee?.id ?? null) === p.id);
      const open = mine.filter((x) => x.status.category !== 'done');
      const counts = Object.fromEntries(statuses.map((s) => [s.id, mine.filter((x) => x.status.id === s.id).length]));
      const lastUpdate = mine.reduce((m, x) => Math.max(m, x.updated_at), 0) || null;
      return {
        ...p,
        counts,
        open: open.length,
        stuck: open.filter((x) => x.stuck).length,
        blocked: open.filter((x) => x.status.category === 'blocked').length,
        done_last_7d: mine.filter((x) => x.status.category === 'done').length,
        oldest_open_ms: open.length ? Math.max(...open.map((x) => x.time_in_status_ms)) : null,
        last_update_at: lastUpdate,
        last_update_ago_ms: lastUpdate ? t - lastUpdate : null,
        tasks: open.sort((a, b) => b.time_in_status_ms - a.time_in_status_ms),
        done: mine.filter((x) => x.status.category === 'done').sort((a, b) => b.closed_at - a.closed_at),
      };
    });
    // Every team member gets a lane (an empty one is useful to see); managers and the
    // Unassigned lane only when they actually hold work.
    const visible = (p) => p.tasks.length || p.done_last_7d || (p.id !== null && p.role !== 'manager');
    return { statuses, people: result.filter(visible) };
  }

  async function agingReport({ windowDays = 30, assigneeId } = {}) {
    const statuses = await listStatuses({ includeArchived: true });
    const t = now();
    const since = windowDays ? t - windowDays * DAY : 0;
    let stints = await allStints();
    if (assigneeId != null && assigneeId !== '') stints = stints.filter((s) => s.assignee_id === Number(assigneeId));
    const open = await listTasks({ assigneeId });
    const median = (xs) => {
      if (!xs.length) return null;
      const a = [...xs].sort((x, y) => x - y);
      const mid = Math.floor(a.length / 2);
      return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
    };
    const rows = statuses
      .filter((s) => s.category !== 'done')
      .map((s) => {
        const finished = stints.filter((x) => x.status_id === s.id && x.end != null && x.end >= since).map((x) => x.end - x.start);
        const current = open.filter((x) => x.status.id === s.id).map((x) => x.time_in_status_ms);
        return {
          status: { id: s.id, name: s.name, color: s.color, category: s.category, archived: s.archived },
          stuck_after_days: s.effective_stuck_days,
          current_count: current.length,
          current_avg_ms: current.length ? current.reduce((a, b) => a + b, 0) / current.length : null,
          current_max_ms: current.length ? Math.max(...current) : null,
          stuck_count: open.filter((x) => x.status.id === s.id && x.stuck).length,
          finished_count: finished.length,
          finished_avg_ms: finished.length ? finished.reduce((a, b) => a + b, 0) / finished.length : null,
          finished_median_ms: median(finished),
        };
      })
      .filter((r) => !r.status.archived || r.current_count || r.finished_count);

    // Start to done: work started -> entering a done status, for tickets closed in the window.
    const closed = await db.all(
      `SELECT t.id, t.created_at, t.closed_at FROM wt.tasks t JOIN wt.statuses s ON s.id = t.status_id
       WHERE s.category = 'done' AND t.closed_at >= ? ${assigneeId ? 'AND t.assignee_id = ?' : ''}`,
      since, ...(assigneeId ? [Number(assigneeId)] : [])
    );
    const cycle = closed.map((c) => c.closed_at - c.created_at);

    return {
      window_days: windowDays,
      statuses: rows,
      stuck: open.filter((x) => x.stuck).sort((a, b) => b.time_in_status_ms - a.time_in_status_ms),
      closed_count: closed.length,
      cycle_avg_ms: cycle.length ? cycle.reduce((a, b) => a + b, 0) / cycle.length : null,
      cycle_median_ms: median(cycle),
    };
  }

  return {
    getSettings, updateSettings, regenerateTeamKey, checkTeamKey,
    listUsers, getUser, upsertPerson, createManager, updateUser, setPassword, hasManager,
    login, sessionUser, logout, ensureManager,
    listStatuses, createStatus, updateStatus, reorderStatuses, archiveStatus, resolveStatus,
    normalizeKey, recordActivity, setDetails, needsDetails, changeStatus, setSummary, addComment, deleteTask,
    listTasks, getTask, teamSummary, agingReport,
  };
}

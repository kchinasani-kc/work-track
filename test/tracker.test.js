import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, migrate } from '../src/db.js';
import { createTracker, formatDuration } from '../src/service.js';

const H = 3_600_000;
const D = 24 * H;
const ravi = { email: 'Ravi@Example.com', name: 'Ravi Kumar' };
const asha = { email: 'asha@example.com', name: 'Asha' };
const at = (tracker, who, ticket, extra = {}) =>
  tracker.recordActivity({ person: who, ticket, event: 'SessionStart', ...extra });

async function setup(t) {
  let clock = Date.UTC(2026, 0, 5, 9);
  const db = await connect({ memory: true });
  await migrate(db);
  t.after(() => db.close());
  const tracker = createTracker(db, { now: () => clock, jiraBaseUrl: 'https://acme.atlassian.net' });
  return { tracker, db, advance: (ms) => (clock += ms) };
}

test('first activity creates the ticket in the first active status, with the person from git', async (t) => {
  const { tracker } = await setup(t);
  const r = await at(tracker, ravi, 'PROJ-12');
  assert.equal(r.created, true);
  assert.equal(r.task.key, 'PROJ-12');
  assert.equal(r.task.status.name, 'In Progress');
  assert.equal(r.task.assignee.email, 'ravi@example.com');
  assert.equal(r.task.jira_url, 'https://acme.atlassian.net/browse/PROJ-12');
  assert.equal(r.task.title, null);
  assert.equal(typeof r.task.created_at, 'number');
  // Same person again (different case in git config): no duplicate person, no new ticket.
  const again = await at(tracker, { email: 'ravi@example.com', name: 'Ravi K' }, 'PROJ-12');
  assert.equal(again.created, false);
  assert.equal((await tracker.listUsers()).length, 1);
  // Status tracking only: nothing about sessions, apps or activity is exposed.
  const task12 = await tracker.getTask('proj-12');
  for (const k of ['sessions', 'working_now', 'last_activity_at', 'last_app']) assert.equal(k in task12, false, k);
  assert.deepEqual(task12.events.map((e) => e.note), ['Started in Claude Code']);
});

test('two first reports at the same moment create one ticket and one person', async (t) => {
  const { tracker } = await setup(t);
  const results = await Promise.all([
    at(tracker, ravi, 'PROJ-50'),
    at(tracker, ravi, 'PROJ-50'),
  ]);
  assert.equal(results.filter((r) => r.created).length, 1);
  assert.equal((await tracker.listUsers()).length, 1);
  const task = await tracker.getTask('PROJ-50');
  assert.equal(task.events.filter((e) => e.kind === 'created').length, 1);
});

test('time in each status comes from the event log; done needs a summary from Claude', async (t) => {
  const { tracker, advance } = await setup(t);
  const { person } = await at(tracker, ravi, 'PROJ-1');
  advance(3 * D);
  const r = await tracker.changeStatus('PROJ-1', 'in_review', { note: 'PR open' }, person, 'claude');
  assert.equal(r.previous_status, 'In Progress');
  assert.equal(r.time_in_previous_ms, 3 * D);
  advance(5 * H);
  await assert.rejects(tracker.changeStatus('PROJ-1', 'Done', {}, person, 'claude'), /needs a short summary/);
  await tracker.changeStatus('PROJ-1', 'Done', { summary: 'Fixed the redirect loop and added a test.' }, person, 'claude');
  const task = await tracker.getTask('PROJ-1');
  assert.equal(task.work_summary, 'Fixed the redirect loop and added a test.');
  assert.ok(task.closed_at);
  const by = Object.fromEntries(task.time_by_status.map((s) => [s.name, s.total_ms]));
  assert.deepEqual(by, { 'In Progress': 3 * D, 'In Review': 5 * H, Done: 0 });
  assert.deepEqual(task.events.map((e) => e.kind), ['created', 'status', 'status', 'summary']);
});

test('unknown status error lists the valid ones; unknown ticket explains how tickets appear', async (t) => {
  const { tracker } = await setup(t);
  const { person } = await at(tracker, ravi, 'PROJ-1');
  await assert.rejects(tracker.changeStatus('PROJ-1', 'Doing', {}, person, 'claude'), /Valid statuses: .*"In Progress"/);
  await assert.rejects(tracker.changeStatus('PROJ-999', 'Done', {}, person, 'claude'), /isn't in the tracker yet/);
});

test('project key filter and key validation', async (t) => {
  const { tracker } = await setup(t);
  await assert.rejects(at(tracker, ravi, 'not a key'), /not a Jira ticket key/);
  await tracker.updateSettings({ jira_project_keys: 'proj, ops' });
  await assert.rejects(at(tracker, ravi, 'UTF-8'), /not in a tracked Jira project/);
  assert.equal((await at(tracker, ravi, 'OPS-3')).task.key, 'OPS-3');
});

test('parked tickets stay parked for the rest of the session and restart on a new one', async (t) => {
  const { tracker } = await setup(t);
  const { person } = await at(tracker, ravi, 'PROJ-5');
  await tracker.changeStatus('PROJ-5', 'To Do', { note: 'parked' }, person, 'claude');
  assert.equal((await at(tracker, ravi, 'PROJ-5', { event: 'UserPromptSubmit' })).task.status.name, 'To Do');
  assert.equal((await at(tracker, ravi, 'PROJ-5', { event: 'SessionStart', sessionSource: 'compact' })).task.status.name, 'To Do');
  const r = await at(tracker, asha, 'PROJ-5', { event: 'SessionStart', sessionSource: 'startup' });
  assert.equal(r.task.assignee.name, 'Asha');
  assert.equal(r.task.status.name, 'In Progress');
  const kinds = (await tracker.getTask('PROJ-5')).events.map((e) => e.kind);
  assert.deepEqual(kinds, ['created', 'status', 'assigned', 'status']);
});

test('lowercase branch keys need a project list', async (t) => {
  const { tracker } = await setup(t);
  await assert.rejects(at(tracker, ravi, 'lodash-4'), /isn't uppercase/);
  await tracker.updateSettings({ jira_project_keys: 'PROJ' });
  assert.equal((await at(tracker, ravi, 'proj-9')).task.key, 'PROJ-9');
  await assert.rejects(at(tracker, ravi, 'lodash-4'), /not in a tracked Jira project/);
});

test('details: Jira wins over Claude, errors are recorded', async (t) => {
  const { tracker } = await setup(t);
  await at(tracker, ravi, 'PROJ-2');
  assert.equal(await tracker.needsDetails('PROJ-2'), true);
  await tracker.setDetails('PROJ-2', { title: 'From Claude', description: 'x' }, 'claude');
  await tracker.setDetails('PROJ-2', { title: 'From Jira', description: 'y' }, 'jira');
  await tracker.setDetails('PROJ-2', { title: 'Claude again' }, 'claude');
  assert.equal((await tracker.getTask('PROJ-2')).title, 'From Jira');
  assert.equal(await tracker.needsDetails('PROJ-2'), false);
  await tracker.setDetails('PROJ-2', { error: 'Jira returned HTTP 500' }, 'jira');
  assert.equal((await tracker.getTask('PROJ-2')).details_error, 'Jira returned HTTP 500');
});

test('search is case-insensitive and treats % and _ literally', async (t) => {
  const { tracker } = await setup(t);
  await at(tracker, ravi, 'PROJ-2');
  await tracker.setDetails('PROJ-2', { title: 'Login Redirect Loop', description: '100% broken' }, 'jira');
  assert.equal((await tracker.listTasks({ q: 'redirect' })).length, 1);
  assert.equal((await tracker.listTasks({ q: 'proj-2' })).length, 1);
  assert.equal((await tracker.listTasks({ q: '100%' })).length, 1);
  assert.equal((await tracker.listTasks({ q: '%' + 'zzz' })).length, 0);
});

test('stuck flag follows per-status limits', async (t) => {
  const { tracker, advance } = await setup(t);
  const { person } = await at(tracker, ravi, 'PROJ-1');
  await at(tracker, ravi, 'PROJ-2');
  await tracker.changeStatus('PROJ-2', 'Blocked', { note: 'waiting on API keys' }, person, 'claude');
  advance(2 * D);
  assert.deepEqual((await tracker.listTasks()).filter((x) => x.stuck).map((x) => x.key), ['PROJ-2']);
  advance(2 * D);
  assert.deepEqual((await tracker.listTasks()).filter((x) => x.stuck).map((x) => x.key).sort(), ['PROJ-1', 'PROJ-2']);
});

test('custom statuses: case-insensitive names, rename keeps history, archive moves tickets', async (t) => {
  const { tracker, advance } = await setup(t);
  const qa = await tracker.createStatus({ name: 'QA', color: '#0ea5e9', category: 'active', stuck_after_days: 2 });
  await assert.rejects(tracker.createStatus({ name: 'qa' }), /already exists/);
  const { person } = await at(tracker, ravi, 'PROJ-1');
  await tracker.changeStatus('PROJ-1', 'QA', {}, person, 'claude');
  advance(H);
  await tracker.updateStatus(qa.id, { name: 'Testing' });
  assert.equal((await tracker.getTask('PROJ-1')).status.name, 'Testing');
  await assert.rejects(tracker.archiveStatus(qa.id, {}, person), /1 ticket\(s\) are in "Testing"/);
  await tracker.archiveStatus(qa.id, { moveTo: (await tracker.resolveStatus('In Progress')).id }, person);
  assert.equal((await tracker.getTask('PROJ-1')).status.name, 'In Progress');
  await assert.rejects(tracker.resolveStatus('Testing'), /unknown status/);
  const order = await tracker.reorderStatuses((await tracker.listStatuses()).map((s) => s.id).reverse());
  assert.deepEqual(order.filter((s) => !s.archived).map((s) => s.name), ['Done', 'In Review', 'Blocked', 'In Progress', 'To Do']);
});

test('reports: averages, start-to-done, team lanes with "working on"', async (t) => {
  const { tracker, advance } = await setup(t);
  const { person: r } = await at(tracker, ravi, 'PROJ-1');
  const { person: a } = await at(tracker, asha, 'PROJ-2');
  advance(2 * D);
  await tracker.changeStatus('PROJ-1', 'Done', { summary: 'Shipped.' }, r, 'claude');
  advance(D);
  const aging = await tracker.agingReport({ windowDays: 30 });
  const ip = aging.statuses.find((s) => s.status.name === 'In Progress');
  assert.equal(ip.finished_count, 1);
  assert.equal(ip.finished_avg_ms, 2 * D);
  assert.equal(ip.current_max_ms, 3 * D);
  assert.equal(aging.cycle_avg_ms, 2 * D);
  const team = await tracker.teamSummary();
  const asRow = team.people.find((p) => p.id === a.id);
  assert.deepEqual(asRow.tasks.map((x) => x.key), ['PROJ-2']);
  assert.equal('working_on' in asRow || 'last_seen_at' in asRow, false);
  assert.equal(team.people.find((p) => p.id === r.id).done_last_7d, 1);
});

test('auth: team key, manager sessions, deactivated people are ignored', async (t) => {
  const { tracker } = await setup(t);
  const { team_key } = await tracker.getSettings();
  assert.equal(await tracker.checkTeamKey(team_key), true);
  assert.equal(await tracker.checkTeamKey('wtk_wrong'), false);
  const fresh = await tracker.regenerateTeamKey();
  assert.equal(await tracker.checkTeamKey(team_key), false);
  assert.equal(await tracker.checkTeamKey(fresh), true);
  assert.equal(await tracker.ensureManager({ email: 'x@example.com' }), null, 'no password and not allowed to invent one');
  await assert.rejects(tracker.login('boss@example.com', 'whatever'), /No manager account exists yet/);
  await tracker.ensureManager({ email: 'boss@example.com', password: 'secret-pass' });
  await assert.rejects(tracker.login('boss@example.com', 'nope'), /wrong email or password/);
  const { sid, user } = await tracker.login('BOSS@example.com', 'secret-pass');
  assert.equal((await tracker.sessionUser(sid)).id, user.id);
  await assert.rejects(tracker.updateUser(user.id, { role: 'member' }), /last manager/);
  const { person } = await at(tracker, ravi, 'PROJ-1');
  await tracker.updateUser(person.id, { active: false });
  await assert.rejects(at(tracker, ravi, 'PROJ-1'), /deactivated/);
});

test('durations are reported in days', () => {
  assert.equal(formatDuration(5 * H), 'less than a day');
  assert.equal(formatDuration(D + 5 * H), '1 day');
  assert.equal(formatDuration(3 * D + 23 * H), '3 days');
});

test('upgrading removes activity data stored by earlier versions', async (t) => {
  const { tracker, db } = await setup(t);
  await at(tracker, ravi, 'PROJ-1');
  // What an older version left behind.
  await db.run('CREATE TABLE wt.activity (id integer, app text, session_id text)');
  await db.run("INSERT INTO wt.activity VALUES (1, 'Cursor', 'abc')");
  await db.run('ALTER TABLE wt.users ADD COLUMN last_seen_at bigint');
  await db.run('ALTER TABLE wt.users ADD COLUMN last_app text');
  await db.run('ALTER TABLE wt.tasks ADD COLUMN last_activity_at bigint');
  await db.run("INSERT INTO wt.settings (key, value) VALUES ('active_minutes', '30')");
  await db.run("UPDATE wt.task_events SET note = 'Started in Cursor, branch feature/PROJ-1'");
  await db.run("UPDATE wt.settings SET value = '4' WHERE key = 'schema_version'");
  await migrate(db);
  assert.equal((await db.get("SELECT to_regclass('wt.activity') IS NULL AS gone")).gone, true);
  const cols = (await db.all("SELECT column_name FROM information_schema.columns WHERE table_schema = 'wt' AND column_name IN ('last_seen_at', 'last_app', 'last_activity_at')"));
  assert.deepEqual(cols, []);
  assert.equal(await db.get("SELECT 1 AS x FROM wt.settings WHERE key = 'active_minutes'"), undefined);
  assert.equal((await tracker.getTask('PROJ-1')).events[0].note, 'Started in Claude Code');
});

test('details for a ticket loaded before anyone works on it are kept and applied when work starts', async (t) => {
  const { tracker, db } = await setup(t);
  assert.equal(await tracker.setDetails('PROJ-70', { title: 'From Claude', description: 'c' }, 'claude'), null, 'not tracked yet');
  assert.equal(await tracker.setDetails('PROJ-70', { title: 'From Jira', description: 'j' }, 'jira'), null);
  await tracker.setDetails('PROJ-70', { title: 'Claude again' }, 'claude'); // never overrides Jira data
  const r = await at(tracker, ravi, 'PROJ-70');
  assert.equal(r.task.title, 'From Jira');
  assert.equal(r.task.description, 'j');
  assert.equal(r.task.details_source, 'jira');
  // Title-only update (from the pickup skill's active.json) keeps the description.
  await at(tracker, ravi, 'PROJ-71');
  await tracker.setDetails('PROJ-71', { title: 'Jira title', description: 'Jira body' }, 'jira');
  await tracker.setDetails('PROJ-71', { title: 'Newer Jira title' }, 'jira');
  const t71 = await tracker.getTask('PROJ-71');
  assert.equal(t71.title, 'Newer Jira title');
  assert.equal(t71.description, 'Jira body');
  assert.equal((await db.get('SELECT COUNT(*) AS n FROM wt.jira_details')).n, 2);
});

test('board fields: pod, status descriptions, Jira link, latest note', async (t) => {
  const { tracker } = await setup(t);
  const { person } = await at(tracker, ravi, 'PROJ-1');
  await tracker.updateUser(person.id, { team: 'Pod A' });
  const ip = await tracker.resolveStatus('In Progress');
  assert.equal(ip.description, 'being built');
  await tracker.updateStatus(ip.id, { description: 'coding on the ticket branch' });
  const qa = await tracker.createStatus({ name: 'QA', category: 'active', description: 'on dev, QA testing' });
  assert.equal(qa.description, 'on dev, QA testing');
  await tracker.changeStatus('PROJ-1', 'Blocked', { note: 'Waiting on API keys from the carrier' }, person, 'claude');
  await tracker.addComment('PROJ-1', 'Chased them again', person, 'claude');
  await tracker.setSummary('PROJ-1', 'Not a note', person, 'claude');
  let [task] = await tracker.listTasks();
  assert.equal(task.assignee.team, 'Pod A');
  assert.equal(task.last_note, 'Chased them again', 'latest status/comment note, not the summary');
  assert.equal(task.jira_url, 'https://acme.atlassian.net/browse/PROJ-1', 'falls back to the server setting');
  await tracker.updateSettings({ jira_site_url: 'kcoverseas.atlassian.net/' });
  assert.equal((await tracker.getSettings()).jira_site_url, 'https://kcoverseas.atlassian.net');
  [task] = await tracker.listTasks();
  assert.equal(task.jira_url, 'https://kcoverseas.atlassian.net/browse/PROJ-1');
  await assert.rejects(tracker.updateSettings({ jira_site_url: 'not a url at all' }), /Jira site must be/);
  assert.equal((await tracker.teamSummary()).people.find((p) => p.id === person.id).team, 'Pod A');
});

test('upgrading from schema 5 adds pods and status descriptions', async (t) => {
  const { tracker, db } = await setup(t);
  await db.run('ALTER TABLE wt.users DROP COLUMN team');
  await db.run('ALTER TABLE wt.statuses DROP COLUMN description');
  await db.run("UPDATE wt.settings SET value = '5' WHERE key = 'schema_version'");
  await migrate(db);
  assert.equal((await tracker.resolveStatus('Blocked')).description, 'waiting on someone or something');
  const { person } = await at(tracker, ravi, 'PROJ-1');
  assert.equal((await tracker.updateUser(person.id, { team: 'Mobile' })).team, 'Mobile');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createTracker, appLabel } from '../src/service.js';

const H = 3_600_000;
const D = 24 * H;
const ravi = { email: 'Ravi@Example.com', name: 'Ravi Kumar' };
const asha = { email: 'asha@example.com', name: 'Asha' };
const at = (tracker, who, ticket, extra = {}) =>
  tracker.recordActivity({ person: who, ticket, app: 'Claude desktop', branch: `feature/${ticket}`, sessionId: 's1', ...extra });

function setup() {
  let clock = Date.UTC(2026, 0, 5, 9);
  const tracker = createTracker(openDb(':memory:'), { now: () => clock, jiraBaseUrl: 'https://acme.atlassian.net' });
  return { tracker, advance: (ms) => (clock += ms) };
}

test('first activity creates the ticket in the first active status, with the person from git', () => {
  const { tracker } = setup();
  const r = at(tracker, ravi, 'PROJ-12');
  assert.equal(r.created, true);
  assert.equal(r.task.key, 'PROJ-12');
  assert.equal(r.task.status.name, 'In Progress');
  assert.equal(r.task.assignee.email, 'ravi@example.com');
  assert.equal(r.task.jira_url, 'https://acme.atlassian.net/browse/PROJ-12');
  assert.equal(r.task.title, null);
  assert.equal(r.task.working_now, true);
  // Same person again: no duplicate person, no new ticket.
  const again = at(tracker, { email: 'ravi@example.com', name: 'Ravi K' }, 'PROJ-12', { sessionId: 's2' });
  assert.equal(again.created, false);
  assert.equal(tracker.listUsers().length, 1);
  assert.equal(tracker.getTask('PROJ-12').sessions.length, 2);
});

test('time in each status comes from the event log; done needs a summary from Claude', () => {
  const { tracker, advance } = setup();
  const { person } = at(tracker, ravi, 'PROJ-1');
  advance(3 * D);
  const r = tracker.changeStatus('PROJ-1', 'in_review', { note: 'PR open' }, person, 'claude');
  assert.equal(r.previous_status, 'In Progress');
  assert.equal(r.time_in_previous_ms, 3 * D);
  advance(5 * H);
  assert.throws(() => tracker.changeStatus('PROJ-1', 'Done', {}, person, 'claude'), /needs a short summary/);
  tracker.changeStatus('PROJ-1', 'Done', { summary: 'Fixed the redirect loop and added a test.' }, person, 'claude');
  const t = tracker.getTask('PROJ-1');
  assert.equal(t.work_summary, 'Fixed the redirect loop and added a test.');
  assert.ok(t.closed_at);
  const by = Object.fromEntries(t.time_by_status.map((s) => [s.name, s.total_ms]));
  assert.deepEqual(by, { 'In Progress': 3 * D, 'In Review': 5 * H, Done: 0 });
  assert.deepEqual(t.events.map((e) => e.kind), ['created', 'status', 'status', 'summary']);
});

test('unknown status error lists the valid ones; unknown ticket explains how tickets appear', () => {
  const { tracker } = setup();
  const { person } = at(tracker, ravi, 'PROJ-1');
  assert.throws(() => tracker.changeStatus('PROJ-1', 'Doing', {}, person, 'claude'), /Valid statuses: .*"In Progress"/);
  assert.throws(() => tracker.changeStatus('PROJ-999', 'Done', {}, person, 'claude'), /isn't in the tracker yet/);
});

test('project key filter and key validation', () => {
  const { tracker } = setup();
  assert.throws(() => at(tracker, ravi, 'not a key'), /not a Jira ticket key/);
  tracker.updateSettings({ jira_project_keys: 'proj, ops' });
  assert.throws(() => at(tracker, ravi, 'UTF-8'), /not in a tracked Jira project/);
  assert.equal(at(tracker, ravi, 'OPS-3').task.key, 'OPS-3');
});

test('parked tickets stay parked for the rest of the session and restart on a new one', () => {
  const { tracker } = setup();
  const { person } = at(tracker, ravi, 'PROJ-5');
  tracker.changeStatus('PROJ-5', 'To Do', { note: 'parked' }, person, 'claude');
  // Next prompt in the same session: still parked.
  assert.equal(at(tracker, ravi, 'PROJ-5', { event: 'UserPromptSubmit' }).task.status.name, 'To Do');
  // Compaction is mid-session too.
  assert.equal(at(tracker, ravi, 'PROJ-5', { event: 'SessionStart', sessionSource: 'compact' }).task.status.name, 'To Do');
  // A new session (here someone else's) picks it up again.
  const r = at(tracker, asha, 'PROJ-5', { sessionId: 's9', event: 'SessionStart', sessionSource: 'startup' });
  assert.equal(r.task.assignee.name, 'Asha');
  assert.equal(r.task.status.name, 'In Progress');
  const kinds = tracker.getTask('PROJ-5').events.map((e) => e.kind);
  assert.deepEqual(kinds, ['created', 'status', 'assigned', 'status']);
});

test('lowercase branch keys need a project list', () => {
  const { tracker } = setup();
  assert.throws(() => at(tracker, ravi, 'lodash-4'), /isn't uppercase/);
  tracker.updateSettings({ jira_project_keys: 'PROJ' });
  assert.equal(at(tracker, ravi, 'proj-9').task.key, 'PROJ-9');
  assert.throws(() => at(tracker, ravi, 'lodash-4'), /not in a tracked Jira project/);
});

test('details: Jira wins over Claude, errors are recorded', () => {
  const { tracker } = setup();
  at(tracker, ravi, 'PROJ-2');
  assert.equal(tracker.needsDetails('PROJ-2'), true);
  tracker.setDetails('PROJ-2', { title: 'From Claude', description: 'x' }, 'claude');
  tracker.setDetails('PROJ-2', { title: 'From Jira', description: 'y' }, 'jira');
  tracker.setDetails('PROJ-2', { title: 'Claude again' }, 'claude');
  assert.equal(tracker.getTask('PROJ-2').title, 'From Jira');
  assert.equal(tracker.needsDetails('PROJ-2'), false);
  tracker.setDetails('PROJ-2', { error: 'Jira returned HTTP 500' }, 'jira');
  assert.equal(tracker.getTask('PROJ-2').details_error, 'Jira returned HTTP 500');
});

test('stuck flag follows per-status limits', () => {
  const { tracker, advance } = setup();
  const { person } = at(tracker, ravi, 'PROJ-1');
  at(tracker, ravi, 'PROJ-2');
  tracker.changeStatus('PROJ-2', 'Blocked', { note: 'waiting on API keys' }, person, 'claude');
  advance(2 * D);
  assert.deepEqual(tracker.listTasks().filter((t) => t.stuck).map((t) => t.key), ['PROJ-2']);
  advance(2 * D);
  assert.deepEqual(tracker.listTasks().filter((t) => t.stuck).map((t) => t.key).sort(), ['PROJ-1', 'PROJ-2']);
  assert.equal(tracker.getTask('PROJ-1').working_now, false);
});

test('custom statuses: rename keeps history, archive moves tickets', () => {
  const { tracker, advance } = setup();
  const qa = tracker.createStatus({ name: 'QA', color: '#0ea5e9', category: 'active', stuck_after_days: 2 });
  const { person } = at(tracker, ravi, 'PROJ-1');
  tracker.changeStatus('PROJ-1', 'QA', {}, person, 'claude');
  advance(H);
  tracker.updateStatus(qa.id, { name: 'Testing' });
  assert.equal(tracker.getTask('PROJ-1').status.name, 'Testing');
  assert.throws(() => tracker.archiveStatus(qa.id, {}, person), /1 ticket\(s\) are in "Testing"/);
  tracker.archiveStatus(qa.id, { moveTo: tracker.resolveStatus('In Progress').id }, person);
  assert.equal(tracker.getTask('PROJ-1').status.name, 'In Progress');
  assert.throws(() => tracker.resolveStatus('Testing'), /unknown status/);
});

test('reports: averages, start-to-done, team lanes with "working on"', () => {
  const { tracker, advance } = setup();
  const { person: r } = at(tracker, ravi, 'PROJ-1');
  const { person: a } = at(tracker, asha, 'PROJ-2', { sessionId: 's2' });
  advance(2 * D);
  tracker.changeStatus('PROJ-1', 'Done', { summary: 'Shipped.' }, r, 'claude');
  advance(D);
  const aging = tracker.agingReport({ windowDays: 30 });
  const ip = aging.statuses.find((s) => s.status.name === 'In Progress');
  assert.equal(ip.finished_count, 1);
  assert.equal(ip.finished_avg_ms, 2 * D);
  assert.equal(ip.current_max_ms, 3 * D);
  assert.equal(aging.cycle_avg_ms, 2 * D);
  at(tracker, asha, 'PROJ-2', { sessionId: 's3', app: 'Cursor' });
  const team = tracker.teamSummary();
  const asRow = team.people.find((p) => p.id === a.id);
  assert.equal(asRow.working_on.jira_key, 'PROJ-2');
  assert.equal(asRow.working_on.app, 'Cursor');
  assert.equal(team.people.find((p) => p.id === r.id).done_last_7d, 1);
});

test('auth: team key, manager sessions, deactivated people are ignored', () => {
  const { tracker } = setup();
  const { team_key } = tracker.getSettings();
  assert.ok(tracker.checkTeamKey(team_key));
  assert.ok(!tracker.checkTeamKey('wtk_wrong'));
  const fresh = tracker.regenerateTeamKey();
  assert.ok(!tracker.checkTeamKey(team_key) && tracker.checkTeamKey(fresh));
  tracker.ensureManager({ email: 'boss@example.com', password: 'secret-pass' });
  assert.throws(() => tracker.login('boss@example.com', 'nope'), /wrong email or password/);
  const { sid, user } = tracker.login('BOSS@example.com', 'secret-pass');
  assert.equal(tracker.sessionUser(sid).id, user.id);
  assert.throws(() => tracker.updateUser(user.id, { role: 'member' }), /last manager/);
  const { person } = at(tracker, ravi, 'PROJ-1');
  tracker.updateUser(person.id, { active: false });
  assert.throws(() => at(tracker, ravi, 'PROJ-1'), /deactivated/);
});

test('app labels from raw hook hints', () => {
  assert.equal(appLabel({ entrypoint: 'claude-desktop', bundle: 'com.anthropic.claudefordesktop' }), 'Claude desktop');
  assert.equal(appLabel({ entrypoint: 'claude-vscode', bundle: 'com.todesktop.230313mzl4w4u92' }), 'Cursor');
  assert.equal(appLabel({ entrypoint: 'claude-vscode', bundle: 'com.microsoft.VSCode' }), 'VS Code');
  assert.equal(appLabel({ entrypoint: 'cli', term_program: 'Apple_Terminal' }), 'Terminal');
  assert.equal(appLabel({}), 'Claude Code');
});

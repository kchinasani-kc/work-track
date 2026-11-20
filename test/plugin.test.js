// End-to-end: the plugin's real Python hook and MCP server against a running tracker
// and a fake (read-only) Jira, inside a throwaway git repo on a ticket branch.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createApp } from '../src/server.js';
import { createJiraClient } from '../src/jira.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.PYTHON || 'python3';
const HOOK = path.join(root, 'plugin/scripts/hook.py');
const MCP = path.join(root, 'plugin/scripts/mcp_server.py');

let jiraServer, trackerServer, tracker, db, base, teamKey, repo, otherRepo;
const jiraRequests = [];

const ADF = {
  type: 'doc', version: 1,
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Users bounce between /login and /home.' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Happens on Safari' }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Started after 2.4' }] }] },
    ] },
  ],
};

const listen = (srv) => new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${srv.address().port}`)));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

function gitRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-repo-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 'priya@example.com');
  g('config', 'user.name', 'Priya Sharma');
  g('config', 'commit.gpgsign', 'false');
  g('commit', '-q', '--allow-empty', '-m', 'init');
  g('checkout', '-q', '-B', branch);
  return dir;
}

// Async on purpose: the tracker runs in this same process and must stay free to answer the hook.
function runPy(args, input, env) {
  return new Promise((resolve) => {
    const p = spawn(PY, args, { env });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
    p.stdin.end(input);
  });
}
function runHook(mode, payload, env = {}) {
  return runPy([HOOK, mode], JSON.stringify(payload), {
    PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_OPTION_SERVER_URL: base, CLAUDE_PLUGIN_OPTION_TEAM_KEY: teamKey, ...env,
  });
}

before(async () => {
  jiraServer = http.createServer((req, res) => {
    jiraRequests.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const m = req.url.match(/^\/rest\/api\/3\/issue\/([^?]+)/);
    if (req.method === 'GET' && m && m[1] === 'PROJ-7') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ key: 'PROJ-7', fields: { summary: 'Login redirect loop', description: ADF } }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"errorMessages":["Issue does not exist"]}');
  });
  const jiraUrl = await listen(jiraServer);
  const made = createApp({ database: { memory: true }, jira: createJiraClient({ baseUrl: jiraUrl, email: 'bot@example.com', token: 'jira-test-token' }) });
  ({ tracker, db } = await made.init());
  teamKey = (await tracker.getSettings()).team_key;
  trackerServer = http.createServer(made.app);
  base = await listen(trackerServer);
  repo = gitRepo('feature/PROJ-7');
  otherRepo = gitRepo('main');
});

after(() => {
  trackerServer.close();
  jiraServer.close();
  for (const d of [repo, otherRepo]) fs.rmSync(d, { recursive: true, force: true });
});

test('hook: session start registers the ticket and person, and fills the title from Jira', async () => {
  const r = await runHook('ping', { cwd: repo, session_id: 'sess-1', hook_event_name: 'SessionStart', source: 'startup' }, {
    CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'ping must print nothing (stdout becomes Claude context)');
  let t;
  for (let i = 0; i < 40 && !(t = await tracker.getTask('PROJ-7')).title; i++) await sleep(50);
  assert.equal(t.title, 'Login redirect loop');
  assert.match(t.description, /Users bounce between \/login and \/home\.\n\n- Happens on Safari\n- Started after 2\.4/);
  assert.equal(t.assignee.email, 'priya@example.com');
  assert.equal(t.assignee.name, 'Priya Sharma');
  assert.equal(t.status.name, 'In Progress');
  assert.ok(jiraRequests.every((q) => q.method === 'GET'), 'tracker must only read from Jira');
  assert.equal(jiraRequests[0].auth, `Basic ${Buffer.from('bot@example.com:jira-test-token').toString('base64')}`);
});

test('hook: context line on a ticket branch; silent elsewhere or when misconfigured', async () => {
  const ctx = await runHook('context', { cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(ctx.status, 0);
  assert.match(ctx.stdout, /this session is on Jira ticket PROJ-7 \(branch feature\/PROJ-7\)/);
  const before = (await tracker.listTasks()).length;
  const off = await runHook('ping', { cwd: otherRepo, session_id: 's' });
  assert.equal(off.status, 0);
  assert.equal(off.stdout, '');
  const badKey = await runHook('ping', { cwd: repo, session_id: 's' }, { CLAUDE_PLUGIN_OPTION_TEAM_KEY: 'wtk_wrong' });
  assert.equal(badKey.status, 0);
  const down = await runHook('ping', { cwd: repo, session_id: 's' }, { CLAUDE_PLUGIN_OPTION_SERVER_URL: 'http://127.0.0.1:9' });
  assert.equal(down.status, 0);
  const garbage = await runPy([HOOK, 'ping'], 'not json', { PATH: process.env.PATH });
  assert.equal(garbage.status, 0);
  assert.equal((await tracker.listTasks()).length, before);
});

test('MCP server: Claude reads and updates the ticket as the git user', async () => {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: PY,
    args: [MCP],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, WORK_TRACKER_URL: base, WORK_TRACKER_KEY: teamKey, CLAUDE_PROJECT_DIR: repo },
    stderr: 'pipe',
  }));
  const text = (r) => r.content.map((c) => c.text).join('\n');
  const call = (name, args = {}) => client.callTool({ name, arguments: args });

  assert.match(client.getInstructions(), /nothing in Jira is ever changed/);
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ['add_ticket_note', 'current_ticket', 'get_ticket', 'list_statuses', 'my_tickets', 'set_ticket_details', 'set_work_summary', 'start_ticket', 'team_tickets', 'update_ticket_status']);

  const cur = text(await call('current_ticket'));
  assert.match(cur, /PROJ-7: Login redirect loop/);
  assert.match(cur, /Status: In Progress/);

  assert.match(text(await call('update_ticket_status', { ticket: 'proj-7', status: 'in review', note: 'PR #41 open' })), /PROJ-7 moved In Progress -> In Review/);
  const bad = await call('update_ticket_status', { ticket: 'PROJ-7', status: 'Shipped' });
  assert.equal(bad.isError, true);
  assert.match(text(bad), /Valid statuses:/);
  const noSummary = await call('update_ticket_status', { ticket: 'PROJ-7', status: 'Done' });
  assert.equal(noSummary.isError, true);
  assert.match(text(noSummary), /needs a short summary/);
  assert.match(text(await call('update_ticket_status', { ticket: 'PROJ-7', status: 'Done', note: 'merged', summary: 'Fixed the Safari redirect loop by clearing the stale session cookie; added a regression test.' })), /In Review -> Done/);

  // A ticket Jira doesn't know: Claude supplies the title itself.
  const started = text(await call('start_ticket', { ticket: 'OPS-1', title: 'Rotate API keys', description: 'Quarterly rotation' }));
  assert.match(started, /Added OPS-1 "Rotate API keys"/);
  assert.match(text(await call('add_ticket_note', { ticket: 'OPS-1', note: 'Halfway through' })), /Note added/);
  const mine = text(await call('my_tickets', { include_done: true }));
  assert.match(mine, /2 ticket\(s\) for Priya Sharma/);
  assert.match(text(await call('list_statuses')), /- In Review \(active\)/);
  const detail = text(await call('get_ticket', { ticket: 'PROJ-7' }));
  assert.match(detail, /Work summary:\nFixed the Safari redirect loop/);
  assert.match(detail, /Priya Sharma \(claude\): In Progress -> In Review - PR #41 open/);
  assert.match(text(await call('team_tickets', { person: 'priya' })), /OPS-1/);
  await client.close();

  const t = await tracker.getTask('PROJ-7');
  assert.equal(t.status.name, 'Done');
  assert.ok(t.events.filter((e) => e.source === 'claude').every((e) => e.actor_name === 'Priya Sharma'));
  assert.equal((await tracker.getTask('OPS-1')).details_source, 'claude');
  assert.ok(jiraRequests.every((q) => q.method === 'GET'));
});

test('MCP server: clear message when the tracker is not configured', async () => {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: PY, args: [MCP],
    env: { PATH: process.env.PATH, HOME: '/nonexistent', WORK_TRACKER_URL: '${user_config.server_url}', CLAUDE_PROJECT_DIR: repo },
    stderr: 'pipe',
  }));
  const r = await client.callTool({ name: 'list_statuses', arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /isn't configured/);
  await client.close();
});

// ---- Capturing ticket details when Claude loads a Jira ticket (e.g. the jira-pickup skill) ----

const issueJson = (key, summary, description) => JSON.stringify({ key, id: '10042', fields: { summary, description, status: { name: 'To Do' }, parent: { key: 'CAP-99', fields: { summary: 'Parent epic' } } } });

async function jiraHook(toolResponse, toolInput = { cloudId: 'x', issueIdOrKey: 'CAP-1' }, toolName = 'mcp__plugin_dev-workflow_atlassian__getJiraIssue') {
  return runPy([HOOK, 'jira'], JSON.stringify({ hook_event_name: 'PostToolUse', cwd: otherRepo, tool_name: toolName, tool_input: toolInput, tool_response: toolResponse }), {
    PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_OPTION_SERVER_URL: base, CLAUDE_PLUGIN_OPTION_TEAM_KEY: teamKey,
  });
}

async function waitFor(fn, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > until) return v;
    await sleep(50);
  }
}

test('jira hook: captures title + description from the Jira response, before the ticket is tracked', async () => {
  // MCP result as content blocks with the issue JSON as text, ADF description, a nested parent issue.
  const r = await jiraHook({ content: [{ type: 'text', text: issueJson('CAP-1', 'Fix invoice rounding', ADF) }] });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /saved CAP-1 "Fix invoice rounding".*start_ticket.*summary/);
  const cached = await waitFor(() => db.get("SELECT * FROM wt.jira_details WHERE jira_key = 'CAP-1'"));
  assert.equal(cached?.title, 'Fix invoice rounding');
  assert.match(cached.description, /Users bounce between/);
  assert.equal((await tracker.listTasks()).some((t) => t.key === 'CAP-1'), false, 'loading a ticket does not start tracking it');

  // Work starts on its branch: the ticket appears with the captured details (no Jira lookup needed).
  const capRepo = gitRepo('feature/CAP-1');
  const ping = await runHook('ping', { cwd: capRepo, session_id: 'cap-1', hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(ping.status, 0);
  const t = await waitFor(async () => (await tracker.listTasks()).find((x) => x.key === 'CAP-1'));
  assert.equal(t.title, 'Fix invoice rounding');
  assert.equal(t.details_source, 'jira');
  fs.rmSync(capRepo, { recursive: true, force: true });
});

test('jira hook: other response shapes, and non-issues are ignored quietly', async () => {
  // Plain JSON string with a markdown description (responseContentFormat: markdown).
  let r = await jiraHook(issueJson('CAP-2', 'Markdown one', '**Bold** text\n\n- item'), { issueIdOrKey: 'cap-2' });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /CAP-2/);
  assert.equal((await waitFor(() => db.get("SELECT * FROM wt.jira_details WHERE jira_key = 'CAP-2'")))?.description, '**Bold** text\n\n- item');
  // Array of content blocks, looked up by numeric id.
  r = await jiraHook([{ type: 'text', text: issueJson('CAP-3', 'By id', null) }], { issueIdOrKey: '10042' });
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /CAP-3/);
  // Errors and unrelated payloads: exit 0, no output.
  for (const bad of ['{"error":true,"statusCode":404}', 'Issue does not exist', { content: [{ type: 'text', text: 'not json' }] }, null]) {
    r = await jiraHook(bad);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('ping: the title from the pickup skill\'s active.json fills in a ticket Jira gave us nothing for', async () => {
  const actRepo = gitRepo('fix/ACT-5');
  fs.mkdirSync(path.join(actRepo, '.claude', 'jira-state'), { recursive: true });
  fs.writeFileSync(path.join(actRepo, '.claude', 'jira-state', 'active.json'), JSON.stringify({ key: 'ACT-5', summary: 'Title from active.json', branch: 'fix/ACT-5' }));
  await runHook('ping', { cwd: actRepo, session_id: 'act-5', hook_event_name: 'SessionStart', source: 'startup' });
  const t = await waitFor(async () => (await tracker.listTasks()).find((x) => x.key === 'ACT-5' && x.title));
  assert.equal(t.title, 'Title from active.json');
  fs.rmSync(actRepo, { recursive: true, force: true });
});

test('start_ticket records a starting summary that can be replaced at the end', async () => {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: PY, args: [MCP],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, WORK_TRACKER_URL: base, WORK_TRACKER_KEY: teamKey, CLAUDE_PROJECT_DIR: otherRepo },
    stderr: 'pipe',
  }));
  assert.match(client.getInstructions(), /start_ticket with the key and `summary`/);
  const r = await client.callTool({ name: 'start_ticket', arguments: { ticket: 'CAP-2', summary: 'Rounding is off by a cent on multi-currency invoices; plan is to round once at the end.' } });
  assert.match(r.content[0].text, /Added CAP-2 "Markdown one"/);
  let t = await tracker.getTask('CAP-2');
  assert.match(t.work_summary, /round once at the end/);
  await client.callTool({ name: 'update_ticket_status', arguments: { ticket: 'CAP-2', status: 'Done', summary: 'Rounded once per invoice; added tests for EUR and INR.' } });
  t = await tracker.getTask('CAP-2');
  assert.equal(t.work_summary, 'Rounded once per invoice; added tests for EUR and INR.');
  assert.equal(t.events.filter((e) => e.kind === 'summary').length, 2);
  await client.close();
});

test('jira hook: Claude is nudged once per ticket per session, details are saved every time', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-data-'));
  const run = (key, session) => runPy([HOOK, 'jira'], JSON.stringify({
    hook_event_name: 'PostToolUse', session_id: session, cwd: otherRepo, tool_name: 'mcp__3a9e8094-de57-4b9e-b8d3-f1fbb4b2921c__getJiraIssue',
    tool_input: { issueIdOrKey: key }, tool_response: issueJson(key, `Title ${key}`, 'body'),
  }), { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_PLUGIN_OPTION_SERVER_URL: base, CLAUDE_PLUGIN_OPTION_TEAM_KEY: teamKey, CLAUDE_PLUGIN_DATA: dataDir });
  const first = await run('CAP-7', 's-a');
  assert.match(JSON.parse(first.stdout).hookSpecificOutput.additionalContext, /Only if CAP-7 is the ticket the user is starting/);
  assert.equal((await run('CAP-7', 's-a')).stdout, '', 'same ticket, same session: no second nudge');
  assert.match((await run('CAP-7', 's-b')).stdout, /CAP-7/, 'new session: nudged again');
  assert.ok(await waitFor(() => db.get("SELECT 1 AS x FROM wt.jira_details WHERE jira_key = 'CAP-7'")));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('privacy: the plugin sends only who and which ticket, and never hooks every prompt', async () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(root, 'plugin/hooks/hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'SessionStart']);
  // Capture exactly what the session-start hook sends.
  const bodies = [];
  const spy = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => { bodies.push(JSON.parse(b)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); });
  });
  const spyUrl = await listen(spy);
  await runHook('ping', { cwd: repo, session_id: 'secret-session', transcript_path: '/x', hook_event_name: 'SessionStart', source: 'startup', prompt: 'private prompt' }, {
    CLAUDE_PLUGIN_OPTION_SERVER_URL: spyUrl, CLAUDE_CODE_ENTRYPOINT: 'cli', TERM_PROGRAM: 'iTerm.app',
  });
  spy.close();
  assert.equal(bodies.length, 1);
  assert.deepEqual(Object.keys(bodies[0]).sort(), ['event', 'person', 'session_source', 'ticket', 'title']);
  assert.deepEqual(Object.keys(bodies[0].person).sort(), ['email', 'name']);
  assert.doesNotMatch(JSON.stringify(bodies[0]), /secret-session|private prompt|iTerm|cli/);
});

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

let jiraServer, trackerServer, tracker, base, teamKey, repo, otherRepo;
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
  const made = createApp({ dbFile: ':memory:', jira: createJiraClient({ baseUrl: jiraUrl, email: 'bot@example.com', token: 'jira-test-token' }) });
  tracker = made.tracker;
  teamKey = tracker.getSettings().team_key;
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

test('hook: ping records the ticket, person and app, and fills the title from Jira', async () => {
  const r = await runHook('ping', { cwd: repo, session_id: 'sess-1', hook_event_name: 'UserPromptSubmit', prompt: 'fix it' }, {
    CLAUDE_CODE_ENTRYPOINT: 'claude-vscode', __CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'ping must print nothing (stdout becomes Claude context)');
  let t;
  for (let i = 0; i < 40 && !(t = tracker.getTask('PROJ-7')).title; i++) await sleep(50);
  assert.equal(t.title, 'Login redirect loop');
  assert.match(t.description, /Users bounce between \/login and \/home\.\n\n- Happens on Safari\n- Started after 2\.4/);
  assert.equal(t.assignee.email, 'priya@example.com');
  assert.equal(t.assignee.name, 'Priya Sharma');
  assert.equal(t.status.name, 'In Progress');
  assert.equal(t.sessions[0].app, 'Cursor');
  assert.equal(t.sessions[0].branch, 'feature/PROJ-7');
  assert.ok(jiraRequests.every((q) => q.method === 'GET'), 'tracker must only read from Jira');
  assert.equal(jiraRequests[0].auth, `Basic ${Buffer.from('bot@example.com:jira-test-token').toString('base64')}`);
});

test('hook: context line on a ticket branch; silent elsewhere or when misconfigured', async () => {
  const ctx = await runHook('context', { cwd: repo, hook_event_name: 'SessionStart', source: 'startup' });
  assert.equal(ctx.status, 0);
  assert.match(ctx.stdout, /this session is on Jira ticket PROJ-7 \(branch feature\/PROJ-7\)/);
  const before = tracker.listTasks().length;
  const off = await runHook('ping', { cwd: otherRepo, session_id: 's' });
  assert.equal(off.status, 0);
  assert.equal(off.stdout, '');
  const badKey = await runHook('ping', { cwd: repo, session_id: 's' }, { CLAUDE_PLUGIN_OPTION_TEAM_KEY: 'wtk_wrong' });
  assert.equal(badKey.status, 0);
  const down = await runHook('ping', { cwd: repo, session_id: 's' }, { CLAUDE_PLUGIN_OPTION_SERVER_URL: 'http://127.0.0.1:9' });
  assert.equal(down.status, 0);
  const garbage = await runPy([HOOK, 'ping'], 'not json', { PATH: process.env.PATH });
  assert.equal(garbage.status, 0);
  assert.equal(tracker.listTasks().length, before);
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

  const t = tracker.getTask('PROJ-7');
  assert.equal(t.status.name, 'Done');
  assert.ok(t.events.filter((e) => e.source === 'claude').every((e) => e.actor_name === 'Priya Sharma'));
  assert.equal(tracker.getTask('OPS-1').details_source, 'claude');
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

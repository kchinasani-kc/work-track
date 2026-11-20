// HTTP-level checks (auth guards, startup errors) and the production database driver
// (postgres.js, used with Supabase) run against a Postgres wire-protocol server.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createApp } from '../src/server.js';
import { connect, migrate } from '../src/db.js';
import { createTracker } from '../src/service.js';

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function start(options) {
  const made = createApp(options);
  const srv = http.createServer(made.app);
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  servers.push(srv);
  return { ...made, base: `http://127.0.0.1:${srv.address().port}` };
}

const json = (body, extra = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });

test('auth guards: team key, dashboard session, password', async () => {
  const { base, init } = await start({ database: { memory: true }, admin: { email: 'boss@example.com', password: 'secret-pass' } });
  const { tracker } = await init();
  const key = (await tracker.getSettings()).team_key;

  assert.equal((await fetch(`${base}/api/claude/statuses`, json({}))).status, 401, 'no team key');
  assert.equal((await fetch(`${base}/api/claude/statuses`, json({}, { Authorization: 'Bearer wtk_wrong' }))).status, 401, 'wrong team key');
  assert.equal((await fetch(`${base}/api/claude/statuses`, json({}, { Authorization: `Bearer ${key.slice(0, -1)}x` }))).status, 401, 'nearly right key');
  const ok = await fetch(`${base}/api/claude/statuses`, json({}, { Authorization: `Bearer ${key}` }));
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).statuses.length >= 5);

  for (const p of ['/api/tasks', '/api/bootstrap', '/api/users', '/api/settings']) {
    assert.equal((await fetch(`${base}${p}`)).status, 401, `${p} without a session`);
  }
  assert.equal((await fetch(`${base}/api/tasks`, { headers: { Cookie: 'wt_session=forged' } })).status, 401, 'forged cookie');
  assert.equal((await fetch(`${base}/api/login`, json({ email: 'boss@example.com', password: 'nope' }))).status, 401, 'wrong password');
  assert.equal((await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a' })).status, 415);

  const login = await fetch(`${base}/api/login`, json({ email: 'BOSS@example.com', password: 'secret-pass' }));
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const boot = await fetch(`${base}/api/bootstrap`, { headers: { Cookie: cookie } });
  assert.equal(boot.status, 200);
  const b = await boot.json();
  assert.equal(b.me.email, 'boss@example.com');
  assert.equal(b.settings.team_key, key);

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Work Tracker<\/title>/);
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true, database: 'pglite' });
});

test('startup problems give a readable error and the page still loads', async () => {
  const { base } = await start({ database: { missing: 'DATABASE_URL is not set.' } });
  const r = await fetch(`${base}/api/me`);
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /DATABASE_URL is not set/);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('no manager and no ADMIN_PASSWORD: login explains what to set', async () => {
  const { base } = await start({ database: { memory: true }, admin: {} });
  const r = await fetch(`${base}/api/login`, json({ email: 'a@b.c', password: 'whatever1' }));
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /Set ADMIN_EMAIL and ADMIN_PASSWORD/);
});

test('postgres.js driver (as used with Supabase) over the Postgres wire protocol', async (t) => {
  const pg = new PGlite();
  await pg.waitReady;
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db: pg, host: '127.0.0.1', port });
  await server.start();
  t.after(async () => {
    await server.stop();
    await pg.close();
  });

  const db = await connect({ url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 });
  t.after(() => db.close());
  assert.equal(db.kind, 'postgres');
  await migrate(db);
  await migrate(db); // second cold start: no-op
  const tracker = createTracker(db);

  const person = { email: 'dev@example.com', name: 'Dev' };
  const first = await Promise.all([
    tracker.recordActivity({ person, ticket: 'PROJ-1', event: 'SessionStart' }),
    tracker.recordActivity({ person, ticket: 'PROJ-1', event: 'SessionStart' }),
  ]);
  assert.equal(first.filter((r) => r.created).length, 1);
  const actor = first[0].person;
  const moved = await tracker.changeStatus('PROJ-1', 'Done', { summary: 'Done and dusted.' }, actor, 'claude');
  assert.equal(moved.changed, true);
  const task = await tracker.getTask('PROJ-1');
  assert.equal(typeof task.created_at, 'number', 'bigint timestamps come back as numbers');
  assert.equal(typeof task.time_by_status[0].total_ms, 'number');
  assert.equal(task.work_summary, 'Done and dusted.');
  const users = await tracker.listUsers();
  assert.equal(users.length, 1);
  assert.equal(typeof users[0].open_tasks, 'number', 'COUNT(*) comes back as a number');
  await assert.rejects(tracker.changeStatus('PROJ-1', 'Nope', {}, actor, 'claude'), /unknown status/);
  // A failed transaction rolls back cleanly and the connection stays usable.
  await assert.rejects(tracker.archiveStatus((await tracker.resolveStatus('Done')).id, { moveTo: 999999 }, actor), /status not found/);
  assert.equal((await tracker.getTask('PROJ-1')).status.name, 'Done');
});

test('connection strings: passwords with special characters are escaped once', async () => {
  const { normalizeDbUrl } = await import('../src/db.js');
  const host = 'aws-0-ap-south-1.pooler.supabase.com:6543/postgres';
  assert.equal(normalizeDbUrl(`postgresql://postgres.ref:abc@123@${host}`), `postgresql://postgres.ref:abc%40123@${host}`);
  assert.equal(normalizeDbUrl(`postgresql://postgres.ref:abc%40123@${host}`), `postgresql://postgres.ref:abc%40123@${host}`, 'already encoded');
  assert.equal(normalizeDbUrl(`postgresql://postgres.ref:50%off/#x?@${host}`), `postgresql://postgres.ref:50%25off%2F%23x%3F@${host}`);
  assert.equal(normalizeDbUrl(`postgresql://postgres.ref:plain@${host}?sslmode=require`), `postgresql://postgres.ref:plain@${host}?sslmode=require`);
  assert.equal(normalizeDbUrl(' postgres://u:p@localhost:5432/db '), 'postgres://u:p@localhost:5432/db');
});

import express from 'express';
import { AppError } from './service.js';
import { refreshFromJira } from './jira.js';

const COOKIE = 'wt_session';

function readCookie(req, name) {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** Dashboard REST API. Every route except login requires a manager session. */
export function apiRouter(tracker, { secureCookies = false, publicUrl = null, jira = null, pluginSource = null } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  // CSRF guard: browsers can't send a cross-site JSON body without a CORS preflight,
  // which this server never approves, so requiring JSON on writes is enough.
  r.use((req, res, next) => {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: 'requests must be JSON' });
    }
    next();
  });

  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (err) {
      if (err instanceof AppError) return res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
      console.error('[api]', req.method, req.path, err);
      res.status(500).json({ error: 'internal error' });
    }
  };

  r.post('/login', wrap((req, res) => {
    const { sid, user, maxAgeMs } = tracker.login(req.body?.email, req.body?.password);
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: maxAgeMs, path: '/' });
    return { user };
  }));

  r.post('/logout', wrap((req, res) => {
    tracker.logout(readCookie(req, COOKIE));
    res.clearCookie(COOKIE, { path: '/' });
  }));

  // Everything below needs a signed-in manager.
  r.use((req, res, next) => {
    const user = tracker.sessionUser(readCookie(req, COOKIE));
    if (!user) return res.status(401).json({ error: 'sign in required' });
    req.user = user;
    next();
  });

  const q = (v) => (v === undefined || v === '' ? undefined : v);

  r.get('/me', wrap((req) => ({ user: req.user })));

  r.get('/bootstrap', wrap((req) => ({
    me: req.user,
    settings: tracker.getSettings(),
    public_url: publicUrl,
    plugin_source: pluginSource,
    jira: { configured: !!jira, base_url: jira?.baseUrl ?? null },
    statuses: tracker.listStatuses(),
    users: tracker.listUsers(),
  })));

  // ---- tickets (read-only here: they come from Jira, status comes from Claude) ----
  r.get('/tasks', wrap((req) => tracker.listTasks({
    assigneeId: q(req.query.assignee),
    statusId: q(req.query.status),
    includeDone: req.query.include_done === '1',
    doneWithinDays: q(req.query.done_within_days) ? Number(req.query.done_within_days) : undefined,
    q: q(req.query.q),
  })));
  r.get('/tasks/:ref', wrap((req) => tracker.getTask(req.params.ref)));
  r.post('/tasks/:ref/refresh', wrap(async (req) => {
    if (!jira) throw new AppError('Jira is not connected on the server (set JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN)', 400);
    await refreshFromJira(tracker, jira, req.params.ref.toUpperCase(), { force: true });
    return tracker.getTask(req.params.ref);
  }));
  r.delete('/tasks/:ref', wrap((req) => tracker.deleteTask(req.params.ref)));

  // ---- reports ----
  r.get('/team', wrap(() => tracker.teamSummary()));
  r.get('/aging', wrap((req) => tracker.agingReport({
    windowDays: req.query.window_days === '0' ? 0 : Number(req.query.window_days ?? 30),
    assigneeId: q(req.query.assignee),
  })));

  // ---- statuses ----
  r.get('/statuses', wrap(() => tracker.listStatuses()));
  r.post('/statuses', wrap((req) => tracker.createStatus(req.body ?? {})));
  r.post('/statuses/reorder', wrap((req) => tracker.reorderStatuses(req.body?.ids)));
  r.patch('/statuses/:id', wrap((req) => tracker.updateStatus(Number(req.params.id), req.body ?? {})));
  r.post('/statuses/:id/archive', wrap((req) => tracker.archiveStatus(Number(req.params.id), { moveTo: req.body?.move_to }, req.user)));

  // ---- people ----
  r.get('/users', wrap(() => tracker.listUsers()));
  r.post('/users', wrap((req) => tracker.createManager({ name: req.body?.name, email: req.body?.email, password: req.body?.password })));
  r.patch('/users/:id', wrap((req) => tracker.updateUser(Number(req.params.id), req.body ?? {})));
  r.post('/users/:id/password', wrap((req) => {
    tracker.setPassword(Number(req.params.id), req.body?.password);
  }));

  // ---- settings ----
  r.get('/settings', wrap(() => tracker.getSettings()));
  r.patch('/settings', wrap((req) => tracker.updateSettings(req.body ?? {})));
  r.post('/settings/team-key', wrap(() => ({ team_key: tracker.regenerateTeamKey() })));

  r.use((req, res) => res.status(404).json({ error: 'not found' }));
  return r;
}

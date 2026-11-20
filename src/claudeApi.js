import express from 'express';
import { AppError, appLabel } from './service.js';
import { refreshFromJira } from './jira.js';

const JIRA_WAIT_MS = 4000;

/**
 * API used by the Work Tracker Claude Code plugin (its hooks and its MCP tools).
 * Auth is the shared team key; the person is the git identity the plugin reads
 * from the developer's repo (`git config user.email` / `user.name`).
 */
export function claudeRouter(tracker, { jira = null } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  r.use(async (req, res, next) => {
    try {
      const key = (req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      const ok = key ? await tracker.checkTeamKey(key) : false;
      if (ok !== true) {
        return res.status(401).json({ error: 'Missing or wrong team key. Ask your manager for the Work Tracker team key.' });
      }
      next();
    } catch (err) {
      next(err);
    }
  });

  const wrap = (fn) => async (req, res) => {
    try {
      res.json((await fn(req.body ?? {})) ?? { ok: true });
    } catch (err) {
      if (err instanceof AppError) return res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
      console.error('[claude-api]', req.path, err);
      res.status(500).json({ error: 'internal error' });
    }
  };

  const actor = (b) => tracker.upsertPerson(b.person ?? {});
  const brief = (t) => ({
    key: t.key, title: t.title, status: t.status.name, status_category: t.status.category,
    assignee: t.assignee?.name ?? null, time_in_status_ms: t.time_in_status_ms, stuck: t.stuck,
    stuck_after_days: t.stuck_after_days, work_summary: t.work_summary, jira_url: t.jira_url,
    details_missing: !t.title, details_error: t.details_error,
  });

  // Fill in Jira details before answering, capped so a slow Jira can't hold the request.
  // (On serverless hosts, work left running after the response may never finish.)
  async function withDetails(key) {
    if (!jira) return;
    await Promise.race([refreshFromJira(tracker, jira, key), new Promise((ok) => setTimeout(ok, JIRA_WAIT_MS))]);
  }

  function activityInput(b) {
    const info = b.app_info ?? {};
    return {
      person: b.person ?? {},
      ticket: b.ticket,
      app: appLabel(info),
      appRaw: [info.entrypoint, info.bundle, info.term_program].filter(Boolean).join(' | ') || null,
      repo: b.repo,
      branch: b.branch,
      sessionId: b.session_id,
      event: b.event,
      sessionSource: b.session_source,
    };
  }

  // Hook: a session is working on a ticket (key taken from the branch name).
  r.post('/activity', wrap(async (b) => {
    const out = await tracker.recordActivity(activityInput(b), 'hook');
    await withDetails(out.task.key);
    return { created: out.created, task: brief(await tracker.getTask(out.task.key)) };
  }));

  // Tool: the person tells Claude which ticket they're on (e.g. working outside a ticket branch).
  r.post('/start', wrap(async (b) => {
    const out = await tracker.recordActivity(activityInput(b), 'claude');
    await withDetails(out.task.key);
    if (b.title && !(await tracker.getTask(out.task.key)).title) {
      await tracker.setDetails(out.task.key, { title: b.title, description: b.description }, 'claude');
    }
    return { created: out.created, task: brief(await tracker.getTask(out.task.key)) };
  }));

  r.post('/statuses', wrap(async () => ({
    statuses: (await tracker.listStatuses({ includeArchived: false })).map((s) => ({ name: s.name, category: s.category, stuck_after_days: s.effective_stuck_days })),
  })));

  r.post('/my-tickets', wrap(async (b) => {
    const me = await actor(b);
    const tickets = await tracker.listTasks({ assigneeId: me.id, includeDone: !!b.include_done, doneWithinDays: 7 });
    return { person: { name: me.name, email: me.email }, tickets: tickets.map(brief) };
  }));

  r.post('/tickets', wrap(async (b) => {
    let assigneeId;
    if (b.assignee) {
      const q = String(b.assignee).toLowerCase();
      const users = await tracker.listUsers();
      const u = users.find((x) => x.email.toLowerCase() === q || x.name.toLowerCase() === q)
        ?? users.filter((x) => x.name.toLowerCase().includes(q)).at(0);
      if (!u) throw new AppError(`nobody called "${b.assignee}" has worked on a ticket yet`, 404);
      assigneeId = u.id;
    }
    const statusId = b.status ? (await tracker.resolveStatus(b.status)).id : undefined;
    const tickets = await tracker.listTasks({ assigneeId, statusId, includeDone: !!b.include_done || !!statusId, doneWithinDays: statusId ? undefined : 7 });
    return { tickets: tickets.map(brief) };
  }));

  r.post('/ticket', wrap(async (b) => {
    const key = String(b.ticket ?? '').toUpperCase();
    await withDetails(key);
    const t = await tracker.getTask(key);
    return {
      ...brief(t),
      description: t.description,
      history: t.events.slice(-30).map((e) => ({
        at: e.created_at, kind: e.kind, by: e.actor_name, source: e.source,
        from: e.from_status_name, to: e.to_status_name, note: e.note,
      })),
      time_by_status: t.time_by_status.map((s) => ({ status: s.name, total_ms: s.total_ms, current: s.current })),
    };
  }));

  r.post('/status', wrap(async (b) => {
    const out = await tracker.changeStatus(b.ticket, b.status, { note: b.note, summary: b.summary }, await actor(b), 'claude');
    return { changed: out.changed, previous_status: out.previous_status, time_in_previous_ms: out.time_in_previous_ms, task: brief(out.task) };
  }));

  r.post('/summary', wrap(async (b) => ({ task: brief(await tracker.setSummary(b.ticket, b.summary, await actor(b), 'claude')) })));
  r.post('/note', wrap(async (b) => ({ task: brief(await tracker.addComment(b.ticket, b.note, await actor(b), 'claude')) })));
  r.post('/details', wrap(async (b) => {
    await actor(b);
    return { task: brief(await tracker.setDetails(b.ticket, { title: b.title, description: b.description }, 'claude')) };
  }));

  r.use((req, res) => res.status(404).json({ error: 'not found' }));
  return r;
}

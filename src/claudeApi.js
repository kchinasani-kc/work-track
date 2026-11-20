import express from 'express';
import { AppError, appLabel } from './service.js';
import { refreshFromJira } from './jira.js';

/**
 * API used by the Work Tracker Claude Code plugin (its hooks and its MCP tools).
 * Auth is the shared team key; the person is the git identity the plugin reads
 * from the developer's repo (`git config user.email` / `user.name`).
 */
export function claudeRouter(tracker, { jira = null } = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '1mb' }));

  r.use((req, res, next) => {
    const h = req.headers.authorization ?? '';
    const key = h.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!key || !tracker.checkTeamKey(key)) {
      return res.status(401).json({ error: 'Missing or wrong team key. Ask your manager for the Work Tracker team key.' });
    }
    next();
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

  // Fill in Jira details. `wait` bounds how long a caller waits; the fetch carries on regardless.
  async function withDetails(key, waitMs) {
    if (!jira) return;
    const p = refreshFromJira(tracker, jira, key);
    if (waitMs) await Promise.race([p, new Promise((ok) => setTimeout(ok, waitMs))]);
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

  // Hook: a session is working on a ticket (from the branch name, or a key in the prompt).
  r.post('/activity', wrap(async (b) => {
    const out = tracker.recordActivity(activityInput(b), 'hook');
    withDetails(out.task.key, 0);
    return { created: out.created, task: brief(out.task) };
  }));

  // Tool: the person tells Claude which ticket they're on (e.g. working outside a ticket branch).
  r.post('/start', wrap(async (b) => {
    const out = tracker.recordActivity(activityInput(b), 'claude');
    await withDetails(out.task.key, 4000);
    if (b.title && !tracker.getTask(out.task.key).title) tracker.setDetails(out.task.key, { title: b.title, description: b.description }, 'claude');
    return { created: out.created, task: brief(tracker.getTask(out.task.key)) };
  }));

  r.post('/statuses', wrap(() => ({
    statuses: tracker.listStatuses({ includeArchived: false }).map((s) => ({ name: s.name, category: s.category, stuck_after_days: s.effective_stuck_days })),
  })));

  r.post('/my-tickets', wrap((b) => {
    const me = actor(b);
    return { person: { name: me.name, email: me.email }, tickets: tracker.listTasks({ assigneeId: me.id, includeDone: !!b.include_done, doneWithinDays: 7 }).map(brief) };
  }));

  r.post('/tickets', wrap((b) => {
    let assigneeId;
    if (b.assignee) {
      const q = String(b.assignee).toLowerCase();
      const u = tracker.listUsers().find((x) => x.email.toLowerCase() === q || x.name.toLowerCase() === q)
        ?? tracker.listUsers().filter((x) => x.name.toLowerCase().includes(q)).at(0);
      if (!u) throw new AppError(`nobody called "${b.assignee}" has worked on a ticket yet`, 404);
      assigneeId = u.id;
    }
    const statusId = b.status ? tracker.resolveStatus(b.status).id : undefined;
    return { tickets: tracker.listTasks({ assigneeId, statusId, includeDone: !!b.include_done || !!statusId, doneWithinDays: statusId ? undefined : 7 }).map(brief) };
  }));

  r.post('/ticket', wrap(async (b) => {
    await withDetails(String(b.ticket ?? '').toUpperCase(), 4000).catch(() => {});
    const t = tracker.getTask(b.ticket);
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

  r.post('/status', wrap((b) => {
    const out = tracker.changeStatus(b.ticket, b.status, { note: b.note, summary: b.summary }, actor(b), 'claude');
    return { changed: out.changed, previous_status: out.previous_status, time_in_previous_ms: out.time_in_previous_ms, task: brief(out.task) };
  }));

  r.post('/summary', wrap((b) => ({ task: brief(tracker.setSummary(b.ticket, b.summary, actor(b), 'claude')) })));
  r.post('/note', wrap((b) => ({ task: brief(tracker.addComment(b.ticket, b.note, actor(b), 'claude')) })));
  r.post('/details', wrap((b) => {
    actor(b);
    return { task: brief(tracker.setDetails(b.ticket, { title: b.title, description: b.description }, 'claude')) };
  }));

  r.use((req, res) => res.status(404).json({ error: 'not found' }));
  return r;
}

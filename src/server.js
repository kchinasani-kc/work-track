import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createTracker } from './service.js';
import { apiRouter } from './api.js';
import { claudeRouter } from './claudeApi.js';
import { createJiraClient } from './jira.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createApp({ dbFile, secureCookies = false, publicUrl = null, now, jira = null, pluginSource = null } = {}) {
  const db = openDb(dbFile);
  const tracker = createTracker(db, { ...(now ? { now } : {}), jiraBaseUrl: jira?.baseUrl ?? null });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Used by the Claude Code plugin (team key + git identity).
  app.use('/api/claude', claudeRouter(tracker, { jira }));

  // Manager dashboard.
  app.use('/api', apiRouter(tracker, { secureCookies, publicUrl, jira, pluginSource }));
  app.use(express.static(path.join(root, 'public'), { index: 'index.html', maxAge: 0 }));

  return { app, db, tracker };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? '127.0.0.1';
  const dbFile = process.env.DB_FILE ?? path.join(root, 'data', 'tracker.db');
  const publicUrl = process.env.PUBLIC_URL ?? `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  const jira = createJiraClient({ baseUrl: process.env.JIRA_BASE_URL, email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN });
  const { app, tracker } = createApp({ dbFile, secureCookies: publicUrl.startsWith('https://'), publicUrl: process.env.PUBLIC_URL || null, jira, pluginSource: process.env.PLUGIN_SOURCE || null });

  const created = tracker.ensureManager({ email: process.env.ADMIN_EMAIL || 'admin@localhost', password: process.env.ADMIN_PASSWORD });

  app.listen(port, host, () => {
    console.log(`Work Tracker running at ${publicUrl}`);
    console.log(`  Dashboard:     ${publicUrl}/`);
    console.log(`  Database:      ${dbFile}`);
    console.log(`  Jira:          ${jira ? `${jira.baseUrl} (read-only)` : 'not connected; titles come from Claude instead (set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)'}`);
    if (['127.0.0.1', 'localhost', '::1'].includes(host)) {
      console.log('');
      console.log('  Only this computer can reach it. So teammates\' Claude Code can report to it, restart with');
      console.log('  HOST=0.0.0.0 and PUBLIC_URL=http://<this machine\'s network name or IP>:' + port);
    }
    if (created) {
      console.log('');
      console.log('  A manager login was created:');
      console.log(`    email:    ${created.email}`);
      console.log(`    password: ${created.generated ? created.password : '(from ADMIN_PASSWORD)'}`);
      if (created.generated) console.log('  Save this password now; it is not shown again. Change it under People.');
    }
  });
}

// Entry point for both `npm start` and Vercel.
//  - `npm start` / `node src/server.js`: listens on PORT.
//  - Vercel: imports this file and uses the default-exported Express app as a function.
// The app object is created synchronously; the database is connected, migrated and
// seeded on the first request that needs it (and retried if that fails).
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, migrate } from './db.js';
import { createTracker } from './service.js';
import { apiRouter } from './api.js';
import { claudeRouter } from './claudeApi.js';
import { createJiraClient } from './jira.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(root, 'public', 'index.html');

/**
 * database: { url } | { dataDir } | { memory: true }
 * admin:    { email, password, allowGenerated } for the first manager login
 */
export function createApp({ database = {}, secureCookies = false, publicUrl = null, now, jira = null, pluginSource = null, admin = {} } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  let ready = null; // { db, tracker, routers, created }
  let pending = null;
  const init = () => {
    if (ready) return Promise.resolve(ready);
    if (!pending) {
      pending = (async () => {
        if (database.missing) throw new Error(database.missing);
        const db = await connect(database);
        await migrate(db);
        const tracker = createTracker(db, { ...(now ? { now } : {}), jiraBaseUrl: jira?.baseUrl ?? null });
        const created = await tracker.ensureManager({ email: admin.email || 'admin@localhost', password: admin.password, allowGenerated: !!admin.allowGenerated });
        const routers = {
          claude: claudeRouter(tracker, { jira }),
          api: apiRouter(tracker, { secureCookies, publicUrl, jira, pluginSource }),
        };
        ready = { db, tracker, routers, created };
        return ready;
      })().finally(() => {
        pending = null; // a failed start is retried on the next request
      });
    }
    return pending;
  };

  const needsDb = async (req, res, next) => {
    try {
      await init();
      next();
    } catch (err) {
      console.error('[startup]', err);
      const hint = database.url
        ? " Check DATABASE_URL: use Supabase's transaction pooler string, and URL-encode special characters (@ # / ? %) in the password."
        : '';
      res.status(503).json({ error: `Work Tracker can't start: ${String(err.message).replace(/\.$/, '')}.${hint}` });
    }
  };

  app.get('/healthz', needsDb, (req, res) => res.json({ ok: true, database: ready.db.kind }));

  // Used by the Claude Code plugin (team key + git identity).
  app.use('/api/claude', needsDb, (req, res, next) => ready.routers.claude(req, res, next));
  // Manager dashboard API.
  app.use('/api', needsDb, (req, res, next) => ready.routers.api(req, res, next));

  // Dashboard page. On Vercel the files in public/ are served by the CDN; `/` may still reach
  // the function, so serve index.html here, or send the browser to the CDN copy.
  app.get('/', (req, res) => {
    if (fs.existsSync(INDEX)) return res.sendFile(INDEX);
    res.redirect(302, '/index.html');
  });
  app.use(express.static(path.join(root, 'public'), { index: 'index.html', maxAge: 0 }));

  return { app, init };
}

// ---------- configuration from environment ----------

function fromEnv(env = process.env) {
  const onVercel = !!env.VERCEL;
  const port = Number(env.PORT ?? 4000);
  const host = env.HOST ?? '127.0.0.1';
  const publicUrl = env.PUBLIC_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : null);
  let database;
  if (env.DATABASE_URL) database = { url: env.DATABASE_URL };
  else if (onVercel) database = { missing: 'DATABASE_URL is not set. Add your Supabase connection string (transaction pooler) in the Vercel project settings and redeploy.' };
  else database = { dataDir: env.LOCAL_DB_DIR || path.join(root, 'data', 'pgdata') };
  return {
    onVercel,
    port,
    host,
    options: {
      database,
      publicUrl,
      secureCookies: onVercel || (publicUrl ?? '').startsWith('https://'),
      pluginSource: env.PLUGIN_SOURCE || null,
      jira: createJiraClient({ baseUrl: env.JIRA_BASE_URL, email: env.JIRA_EMAIL, token: env.JIRA_API_TOKEN }),
      // Only a local run may invent a password (it's printed to the console); on Vercel nobody would see it.
      admin: { email: env.ADMIN_EMAIL, password: env.ADMIN_PASSWORD, allowGenerated: !onVercel },
    },
  };
}

const config = fromEnv();
const { app, init } = createApp(config.options);
export default app;

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { port, host, options } = config;
  const shown = options.publicUrl ?? `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;
  init()
    .then(({ created, db }) => {
      app.listen(port, host, () => {
        console.log(`Work Tracker running at ${shown}`);
        console.log(`  Database:  ${db.kind === 'postgres' ? 'Postgres (DATABASE_URL)' : `embedded Postgres in ${options.database.dataDir}`}`);
        console.log(`  Jira:      ${options.jira ? `${options.jira.baseUrl} (read-only)` : 'not connected; titles come from Claude instead (set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN)'}`);
        if (['127.0.0.1', 'localhost', '::1'].includes(host)) {
          console.log('');
          console.log("  Only this computer can reach it. So teammates' Claude Code can report to it, restart with");
          console.log(`  HOST=0.0.0.0 and PUBLIC_URL=http://<this machine's network name or IP>:${port}`);
        }
        if (created) {
          console.log('');
          console.log('  A manager login was created:');
          console.log(`    email:    ${created.email}`);
          console.log(`    password: ${created.generated ? created.password : '(from ADMIN_PASSWORD)'}`);
          if (created.generated) console.log('  Save this password now; it is not shown again. Change it under People.');
        }
      });
    })
    .catch((err) => {
      console.error(`Work Tracker could not start: ${err.message}`);
      process.exit(1);
    });
}

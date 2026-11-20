// Check the database connection and create the tables if needed.
//   npm run db:check          (reads DATABASE_URL from .env or the environment)
// Prints the host it connected to, never the password.
import { connect, migrate, normalizeDbUrl } from '../src/db.js';

const raw = process.env.DATABASE_URL;
if (!raw) {
  console.error('DATABASE_URL is not set. Add it to .env (Supabase: Connect → Transaction pooler).');
  process.exit(1);
}
let where = '(unparseable connection string)';
try {
  const u = new URL(normalizeDbUrl(raw));
  where = `${u.hostname}:${u.port || 5432} as ${decodeURIComponent(u.username)}`;
} catch {}
console.log(`Connecting to ${where} ...`);

const started = Date.now();
let db;
try {
  db = await connect({ url: raw, max: 1 });
  const { version } = await db.get('SELECT version() AS version');
  console.log(`Connected in ${Date.now() - started} ms: ${version.split(',')[0]}`);
  const t0 = Date.now();
  await db.get('SELECT 1 AS ok');
  console.log(`Round trip: ${Date.now() - t0} ms`);

  await migrate(db);
  const tables = await db.all(
    `SELECT c.relname AS name, c.relrowsecurity AS rls
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'wt' AND c.relkind = 'r' ORDER BY c.relname`
  );
  console.log(`\nTables in schema "wt":`);
  for (const t of tables) {
    const { n } = await db.get(`SELECT COUNT(*) AS n FROM wt.${t.name}`);
    console.log(`  ${t.name.padEnd(12)} ${String(n).padStart(5)} rows   row-level security ${t.rls ? 'on' : 'OFF'}`);
  }
  const version_ = await db.get("SELECT value FROM wt.settings WHERE key = 'schema_version'");
  const manager = await db.get("SELECT COUNT(*) AS n FROM wt.users WHERE role = 'manager' AND active = 1 AND password_hash IS NOT NULL");
  console.log(`\nSchema version: ${version_?.value}`);
  console.log(`Managers who can sign in: ${manager.n}${manager.n ? '' : '  (set ADMIN_EMAIL and ADMIN_PASSWORD, or run: npm run admin -- reset-password you@company.com <password>)'}`);
  await db.close();
  process.exit(0);
} catch (err) {
  console.error(`\nFailed after ${Date.now() - started} ms: ${err.code ? `${err.code} ` : ''}${err.message}`);
  if (/ENOTFOUND|EHOSTUNREACH|ENETUNREACH/.test(`${err.code} ${err.message}`) && /supabase\.co\b/.test(where)) {
    console.error("Supabase's direct host (db.<ref>.supabase.co) only has an IPv6 address. Use the pooler string instead: Connect → Transaction pooler (port 6543).");
  }
  if (/password authentication failed|SASL/i.test(err.message)) {
    console.error('Check the password in DATABASE_URL (Supabase: Project Settings → Database → Reset database password).');
  }
  if (/Tenant or user not found/i.test(err.message)) {
    console.error('For the pooler, the user must be postgres.<project-ref>, exactly as shown in Supabase → Connect.');
  }
  await db?.close().catch(() => {});
  process.exit(1);
}

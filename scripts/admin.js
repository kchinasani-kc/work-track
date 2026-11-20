// Command-line admin helpers for when nobody can sign in.
//   npm run admin -- reset-password <email> <new-password>
//   npm run admin -- list
// Uses DATABASE_URL (e.g. Supabase) when set, otherwise the local embedded database.
// Stop a locally running server first: the embedded database allows one process at a time.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, migrate } from '../src/db.js';
import { createTracker } from '../src/service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = await connect(process.env.DATABASE_URL ? { url: process.env.DATABASE_URL } : { dataDir: process.env.LOCAL_DB_DIR || path.join(root, 'data', 'pgdata') });
await migrate(db);
const tr = createTracker(db);
const [cmd, ...args] = process.argv.slice(2);
let code = 0;

if (cmd === 'reset-password' && args.length === 2) {
  const u = (await tr.listUsers()).find((x) => x.email.toLowerCase() === args[0].toLowerCase());
  if (!u) {
    await tr.createManager({ name: 'Manager', email: args[0], password: args[1] });
    console.log(`Created manager ${args[0]}. They can sign in to the dashboard now.`);
  } else {
    if (u.role !== 'manager' || !u.active) await tr.updateUser(u.id, { role: 'manager', active: true });
    await tr.setPassword(u.id, args[1]);
    console.log(`Password set for ${u.name} <${u.email}>. They can sign in to the dashboard now.`);
  }
} else if (cmd === 'list') {
  for (const u of await tr.listUsers()) console.log(`${u.id}\t${u.role}\t${u.active ? 'active' : 'inactive'}\t${u.name}\t${u.email}`);
} else {
  console.log('Usage:\n  npm run admin -- reset-password <email> <new-password>\n  npm run admin -- list');
  code = cmd ? 1 : 0;
}
await db.close();
process.exit(code);

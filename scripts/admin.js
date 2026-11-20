// Command-line admin helpers for when nobody can sign in.
//   node scripts/admin.js reset-password <email> <new-password>
//   node scripts/admin.js list
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createTracker } from '../src/service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tr = createTracker(openDb(process.env.DB_FILE ?? path.join(root, 'data', 'tracker.db')));
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'reset-password' && args.length === 2) {
  const u = tr.listUsers().find((x) => x.email?.toLowerCase() === args[0].toLowerCase());
  if (!u) { console.error(`No person with email ${args[0]}`); process.exit(1); }
  if (u.role !== 'manager') tr.updateUser(u.id, { role: 'manager' });
  if (!u.active) tr.updateUser(u.id, { active: true });
  tr.setPassword(u.id, args[1]);
  console.log(`Password set for ${u.name} <${u.email}>. They can sign in to the dashboard now.`);
} else if (cmd === 'list') {
  for (const u of tr.listUsers()) console.log(`${u.id}\t${u.role}\t${u.active ? 'active' : 'inactive'}\t${u.name}\t${u.email ?? ''}`);
} else {
  console.log('Usage:\n  node scripts/admin.js reset-password <email> <new-password>\n  node scripts/admin.js list');
  process.exit(cmd ? 1 : 0);
}

// Builds a throwaway demo database: four developers working on Jira tickets in Claude Code
// over the last two weeks, then starts the server on it. Real data (data/tracker.db) is not touched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, migrate } from '../src/db.js';
import { createTracker } from '../src/service.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'data', 'demo-pg');
fs.rmSync(dir, { recursive: true, force: true });

const H = 3_600_000;
const D = 24 * H;
let clock = Date.now() - 14 * D;
const db = await connect({ dataDir: dir });
await migrate(db);
const tr = createTracker(db, { now: () => clock });
const at = (msAgo) => { clock = Date.now() - msAgo; };

await tr.ensureManager({ email: 'admin@localhost', password: 'demo-password' });
await tr.updateSettings({ jira_project_keys: 'PORT,FIN,OPS,UI' });
const people = {
  Priya: { name: 'Priya Sharma', email: 'priya@example.com' },
  Arjun: { name: 'Arjun Mehta', email: 'arjun@example.com' },
  Neha: { name: 'Neha Iyer', email: 'neha@example.com' },
  Vikram: { name: 'Vikram Rao', email: 'vikram@example.com' },
};

// [key, title, description, person, (unused), [[status|null(start), msAgo, note, summary], ...]]
const script = [
  ['PORT-412', 'Partner portal login redirect loop', 'Partners on Safari bounce between /login and /home after the 2.4 release.', 'Priya', 0,
    [[null, 13 * D], ['In Review', 9 * D, 'PR #88 open'], ['Done', 8 * D, 'Merged and deployed', 'Cleared the stale session cookie that Safari kept after logout, which caused the redirect loop. Added a regression test for the login flow.']], 8 * D],
  ['FIN-77', 'Invoice PDF export times out for large clients', 'Exports over ~2,000 lines exceed the 30 s gateway timeout.', 'Priya', 0,
    [[null, 5 * D, 'Profiling the export query'], ['Blocked', 2 * D - 3 * H, 'Waiting on DBA for read-replica access']], 2 * D],
  ['FIN-81', 'Add GST number field to supplier form', 'Capture and validate the GSTIN on the supplier onboarding form.', 'Priya', 0,
    [[null, 9 * H]], 6 * 60000],
  ['OPS-230', 'Shipment tracking webhook retries', 'Carrier webhooks are dropped when our endpoint returns 5xx; add retries with backoff.', 'Arjun', 1,
    [[null, 11 * D], ['In Review', 4 * D - 2 * H, 'Ready for review, waiting on Neha']], 4 * D],
  ['OPS-198', 'Migrate cron jobs to the scheduler', 'Move the 11 legacy cron jobs to the managed scheduler.', 'Arjun', 1,
    [[null, 7 * D, 'Moved 3 of 11 jobs']], 50 * 60000],
  ['UI-51', 'Dashboard: filter by warehouse', 'Add a warehouse filter to the operations dashboard.', 'Neha', 2,
    [[null, 7 * D], ['In Review', 5 * D, 'Screenshots attached to PR'], ['Done', 4 * D, 'Shipped', 'Added a warehouse multi-select to the dashboard filters and wired it to the stock and shipment queries. Filter choice is remembered per user.']], 4 * D],
  ['OPS-241', 'Customs document upload size limit', 'Uploads over 10 MB fail; raise the limit and chunk large files.', 'Neha', 2,
    [[null, 3 * D, 'Raising limit to 25 MB and chunking uploads'], ['In Review', 20 * H, 'PR up']], 3 * 60000],
  ['OPS-255', 'Port container ETA alerts', 'Alert account managers when a container ETA slips by more than a day.', 'Vikram', 3,
    [[null, 4 * D, 'Polling carrier API'], ['Blocked', 3 * D, 'Carrier API keys not issued yet']], 3 * D],
  ['UI-62', 'Rate card editor: bulk import from CSV', 'Let account managers upload a CSV of lane rates instead of typing them in.', 'Neha', 2,
    [[null, 2 * D + 4 * H, 'Parsing done, wiring up validation']], 0],
  ['FIN-84', 'Credit note PDF footer shows wrong GSTIN', 'The footer pulls the default entity GSTIN instead of the branch one.', 'Priya', 0,
    [[null, 3 * D], ['In Review', 30 * H, 'PR #102 up, needs a finance sign-off']], 0],
  ['OPS-260', 'Duplicate carrier webhooks create double events', 'Idempotency key is ignored on retries from one carrier.', 'Arjun', 1,
    [[null, 10 * H, 'Reproduced with the carrier sandbox']], 0],
  ['UI-60', 'Shipment list: sticky table header', 'Keep the header visible while scrolling long shipment lists.', 'Vikram', 3,
    [[null, 26 * H], ['To Do', 20 * H, 'Parked until OPS-255 is unblocked']], 20 * H],
];

for (const [key, title, desc, who, , steps] of script) {
  const person = people[who];
  const [first, ...rest] = steps;
  at(first[1]);
  const { person: actor } = await tr.recordActivity({ person, ticket: key, event: 'SessionStart' });
  await tr.setDetails(key, { title, description: desc }, 'jira');
  if (first[2]) await tr.addComment(key, first[2], actor, 'claude');
  for (const [status, msAgo, note, summary] of rest) {
    at(msAgo);
    await tr.changeStatus(key, status, { note, summary }, actor, 'claude');
  }
}
clock = Date.now();
// Pods, so the Board's pod filter has something to show.
const pods = { 'priya@example.com': 'Pod B', 'arjun@example.com': 'Pod A', 'neha@example.com': 'Pod A', 'vikram@example.com': 'Mobile' };
for (const u of await tr.listUsers()) if (pods[u.email]) await tr.updateUser(u.id, { team: pods[u.email] });
await db.close();
console.log(`Demo data written to ${dir}`);
console.log('Sign in with admin@localhost / demo-password');

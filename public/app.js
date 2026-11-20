// Work Tracker dashboard. Plain ES modules, no build step.
// All user-supplied text is inserted as text nodes via h(); never via innerHTML.
// Tickets are read-only here: titles come from Jira, status comes from each person's Claude Code.

const DAY = 86_400_000;
const REFRESH_MS = 30_000;

const state = {
  me: null,
  settings: null,
  statuses: [],
  users: [],
  jira: { configured: false, base_url: null },
  publicUrl: null,
  pluginSource: null,
  route: 'board',
  filters: { assignee: '', q: '', showDone: false, teamSort: 'wait', window: '30', agingAssignee: '' },
  lastLoaded: null,
  openTaskKey: null,
};

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const deferred = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') {
      for (const [p, val] of Object.entries(v)) {
        if (p.startsWith('--')) el.style.setProperty(p, val);
        else el.style[p] = val;
      }
    } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value' || k === 'checked' || k === 'selected') deferred[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  for (const [k, v] of Object.entries(deferred)) el[k] = v;
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
const $ = (sel, root = document) => root.querySelector(sel);

// ---------- formatting ----------
// Time is shown in days: this is a status board, not a stopwatch.
function fmt(ms) {
  if (ms == null || Number.isNaN(ms)) return '–';
  const d = Math.floor(ms / DAY);
  if (d < 1) return '< 1 day';
  return d === 1 ? '1 day' : `${d} days`;
}
// Averages and medians keep one decimal so short waits still compare.
function fmtAvg(ms) {
  if (ms == null || Number.isNaN(ms)) return '–';
  const d = ms / DAY;
  if (d < 0.1) return '< 0.1 days';
  return `${d < 10 ? d.toFixed(1) : Math.round(d)} days`;
}
const dateTime = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const refreshedAgo = (ts) => {
  const m = Math.floor((Date.now() - ts) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : 'over an hour ago';
};
const daysLabel = (d) => (d === 1 ? '1 day' : `${+d.toFixed(1)} days`);
const titleOf = (t) => t.title || 'Title not loaded from Jira yet';

function heat(task) {
  const limit = (task.stuck_after_days || 0) * DAY;
  if (!limit) return { level: '', frac: null };
  const frac = task.time_in_status_ms / limit;
  return { level: frac >= 1 ? 'hot' : frac >= 0.6 ? 'warm' : '', frac };
}

function initials(name) {
  return (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('');
}
function hue(name) {
  let x = 0;
  for (const ch of name ?? '') x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x % 360;
}
function avatar(person, cls = '') {
  if (!person) return h('span', { class: `avatar none ${cls}`, title: 'Unassigned' }, '–');
  return h('span', { class: `avatar ${cls}`, title: person.name, style: { background: `hsl(${hue(person.name)} 42% 46%)` } }, initials(person.name));
}
function statusPill(s) {
  return h('span', { class: 'pill' }, h('span', { class: 'dot', style: { background: s.color } }), s.name);
}
function waitText(task, cls = '') {
  const { level } = heat(task);
  return h('span', { class: `wait ${level} ${cls}`, title: `In ${task.status.name} since ${dateTime(task.status_changed_at)}` }, fmt(task.time_in_status_ms));
}
function meter(task) {
  const { level, frac } = heat(task);
  if (frac == null) return null;
  return h('div', { class: `meter ${level}`, title: `${Math.round(frac * 100)}% of the ${daysLabel(task.stuck_after_days)} limit for ${task.status.name}` },
    h('i', { style: { width: `${Math.min(100, frac * 100)}%` } }));
}
function jiraLink(t, label = t.key) {
  return t.jira_url
    ? h('a', { class: 'card-key jira-link', href: t.jira_url, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation(), title: 'Open in Jira' }, label)
    : h('span', { class: 'card-key' }, label);
}

// ---------- api ----------
async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, credentials: 'same-origin', headers: {} };
  if (method !== 'GET') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`/api${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    renderLogin();
    throw new Error('Signed out');
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, message);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}
const fail = (err) => {
  if (err.message !== 'Signed out') toast(err.message, 'error');
};
async function copy(text, msg) {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('Copy failed; select the text instead', 'error'); }
}

async function loadMeta() {
  const b = await api('/bootstrap');
  state.me = b.me;
  state.settings = b.settings;
  state.publicUrl = b.public_url ? b.public_url.replace(/\/+$/, '') : null;
  state.pluginSource = b.plugin_source;
  state.jira = b.jira;
  state.statuses = b.statuses;
  state.users = b.users;
}
const activeStatuses = () => state.statuses.filter((s) => !s.archived);
const activeUsers = () => state.users.filter((u) => u.active);

// ---------- shell & routing ----------
const ROUTES = {
  board: { label: 'Board', render: renderBoard },
  team: { label: 'Team', render: renderTeam },
  waiting: { label: 'Waiting time', render: renderWaiting },
  people: { label: 'People', render: renderPeople },
  statuses: { label: 'Statuses', render: renderStatuses },
  connect: { label: 'Connect', render: renderConnect },
};

function currentRoute() {
  const r = location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES[r] ? r : 'board';
}

function renderShell() {
  $('#app').replaceChildren(
    h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), 'Work Tracker'),
      h('nav', { class: 'nav', 'aria-label': 'Main' },
        Object.entries(ROUTES).map(([key, r]) => h('a', { href: `#/${key}`, 'data-route': key }, r.label))),
      h('div', { class: 'spacer' }),
      h('div', { class: 'me' },
        h('span', { class: 'who' }, state.me.name),
        h('button', { class: 'btn ghost sm', onclick: signOut }, 'Sign out'))),
    h('main', { id: 'view' }));
}

async function route() {
  state.route = currentRoute();
  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.route === state.route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${ROUTES[state.route].label} · Work Tracker`;
  await refreshView();
}

async function refreshView() {
  const view = $('#view');
  if (!view) return;
  try {
    const node = await ROUTES[state.route].render();
    view.replaceChildren(node);
    state.lastLoaded = Date.now();
  } catch (err) {
    fail(err);
  }
}

function pageHead(title, sub, ...right) {
  return h('div', { class: 'page-head' },
    h('div', null, h('h1', null, title), sub ? h('p', null, sub) : null),
    h('div', { class: 'spacer' }),
    ...right);
}
const updatedLabel = () => h('span', { class: 'updated', id: 'updated' }, 'Updated just now');

function personSelect(value, onchange, { includeUnassigned = false, label = 'Person' } = {}) {
  return h('select', { 'aria-label': label, value, onchange: (e) => onchange(e.target.value) },
    h('option', { value: '' }, 'Everyone'),
    includeUnassigned ? h('option', { value: 'none' }, 'Unassigned') : null,
    activeUsers().filter((u) => u.role === 'member' || u.open_tasks).map((u) => h('option', { value: String(u.id) }, u.name)));
}

const emptyHint = () => h('div', { class: 'panel', style: { marginTop: '16px' } }, h('div', { class: 'empty' },
  'No tickets yet. A ticket appears here the first time someone works on it in Claude Code, on a git branch named with its Jira key (for example ',
  h('code', null, 'feature/PROJ-123'), '). Set your team up from ', h('a', { href: '#/connect' }, 'Connect'), '.'));

// ---------- board ----------
async function renderBoard() {
  const f = state.filters;
  const params = new URLSearchParams();
  if (f.assignee) params.set('assignee', f.assignee);
  if (f.q) params.set('q', f.q);
  if (f.showDone) { params.set('include_done', '1'); params.set('done_within_days', '14'); }
  let tasks = await api(`/tasks?${params}`);
  const cols = activeStatuses().filter((s) => f.showDone || s.category !== 'done');

  let searchTimer;
  const head = pageHead('Board', 'Every open Jira ticket someone is working on, longest-waiting first in each column.',
    h('div', { class: 'toolbar' },
      personSelect(f.assignee, (v) => { f.assignee = v; refreshView(); }),
      h('input', {
        type: 'search', placeholder: 'Search key, title or summary', value: f.q, 'aria-label': 'Search tickets',
        oninput: (e) => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { f.q = e.target.value.trim(); refreshView().then(() => { const s = $('#view input[type=search]'); s?.focus(); s?.setSelectionRange(s.value.length, s.value.length); }); }, 300); },
      }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.showDone, onchange: (e) => { f.showDone = e.target.checked; refreshView(); } }), 'Show done (14 days)'),
      updatedLabel()));

  const board = h('div', { class: 'board' }, cols.map((s) => {
    const mine = tasks.filter((t) => t.status.id === s.id).sort((a, b) => b.time_in_status_ms - a.time_in_status_ms);
    return h('section', { class: 'column', 'aria-label': s.name },
      h('div', { class: 'column-head', style: { '--status-color': s.color } },
        h('h3', null, s.name),
        h('span', { class: 'count' }, mine.length),
        s.effective_stuck_days ? h('span', { class: 'limit', title: 'Tickets are flagged as stuck after this long' }, `limit ${daysLabel(s.effective_stuck_days)}`) : null),
      h('div', { class: 'cards' }, mine.length ? mine.map(card) : h('div', { class: 'empty', style: { padding: '18px 8px' } }, 'Nothing here')));
  }));

  const wrap = h('div', null, head, board);
  if (!tasks.length && !f.q && !f.assignee) wrap.append(emptyHint());
  return wrap;
}

function card(t) {
  const { level } = heat(t);
  return h('button', {
    class: `card ${level === 'hot' ? 'is-stuck' : ''}`, type: 'button',
    'aria-label': `${t.key} ${titleOf(t)}. ${t.status.name} for ${fmt(t.time_in_status_ms)}${level === 'hot' ? ', stuck' : ''}. ${t.assignee?.name ?? 'Unassigned'}.`,
    onclick: () => openTask(t.key),
  },
    h('div', { class: 'card-top' },
      h('span', { class: 'card-key' }, t.key),
      level === 'hot' ? h('span', { class: 'stuck-flag' }, 'Stuck') : null,
      waitText(t)),
    h('div', { class: `card-title ${t.title ? '' : 'muted'}` }, titleOf(t)),
    t.work_summary ? h('div', { class: 'card-summary' }, t.work_summary) : null,
    meter(t),
    h('div', { class: 'card-foot' },
      avatar(t.assignee),
      h('span', { class: 'name' }, t.assignee?.name ?? 'Unassigned')));
}

// ---------- team ----------
async function renderTeam() {
  const data = await api('/team');
  const f = state.filters;
  const all = data.people.flatMap((p) => p.tasks);
  const maxH = Math.max(1, ...all.map((t) => t.time_in_status_ms / 3_600_000));
  const width = (t) => `${Math.max(2, (Math.log1p(t.time_in_status_ms / 3_600_000) / Math.log1p(maxH)) * 100)}%`;

  const people = [...data.people].sort((a, b) => {
    if (f.teamSort === 'name') return (a.id === null) - (b.id === null) || a.name.localeCompare(b.name);
    return b.stuck - a.stuck || (b.oldest_open_ms ?? -1) - (a.oldest_open_ms ?? -1);
  });

  const head = pageHead('Team', 'Each person’s open tickets, and how long each has been in its current status.',
    h('div', { class: 'toolbar' },
      h('select', { 'aria-label': 'Sort people', value: f.teamSort, onchange: (e) => { f.teamSort = e.target.value; refreshView(); } },
        h('option', { value: 'wait' }, 'Stuck and longest wait first'),
        h('option', { value: 'name' }, 'By name')),
      updatedLabel()));

  if (!data.people.length) return h('div', null, head, emptyHint());

  const lanes = h('div', { class: 'lanes' }, people.map((p) => {
    const counts = data.statuses.filter((s) => p.counts[s.id]).map((s) =>
      h('span', { class: 'pill' }, h('span', { class: 'dot', style: { background: s.color } }), `${s.name} `, h('b', { class: 'mono' }, p.counts[s.id])));
    return h('section', { class: 'lane', 'aria-label': p.name },
      h('div', { class: 'lane-head' },
        p.id === null ? avatar(null, 'lg') : avatar(p, 'lg'),
        h('div', null, h('div', { class: 'lane-name' }, p.name), p.email ? h('div', { class: 'muted', style: { fontSize: '12px' } }, p.email) : null),
        h('div', { class: 'lane-stats' },
          h('span', null, h('b', null, p.open), ' open'),
          p.blocked ? h('span', null, h('b', null, p.blocked), ' blocked') : null,
          p.stuck ? h('span', { class: 'hot' }, h('b', null, p.stuck), ' stuck') : null,
          h('span', null, h('b', null, p.done_last_7d), ' done in the last 7 days'))),
      counts.length ? h('div', { class: 'lane-counts' }, counts) : null,
      p.tasks.length
        ? h('div', { class: 'lane-tasks' }, p.tasks.map((t) => {
            const { level } = heat(t);
            return h('button', { class: 'lane-task', type: 'button', onclick: () => openTask(t.key) },
              h('span', { class: 'card-key' }, t.key),
              h('span', { class: `t ${t.title ? '' : 'muted'}`, title: titleOf(t) }, titleOf(t)),
              h('span', null, statusPill(t.status)),
              h('span', { class: 'track', style: { '--status-color': t.status.color } },
                h('span', { class: `bar ${level === 'hot' ? 'hot' : ''}`, style: { width: width(t) } }),
                waitText(t)));
          }))
        : h('div', { class: 'lane-empty' }, 'No open tickets.'),
      p.done?.length ? h('details', { class: 'lane-done' },
        h('summary', null, `Finished in the last 7 days (${p.done.length})`),
        p.done.map((t) => h('button', { class: 'done-row', type: 'button', onclick: () => openTask(t.key) },
          h('span', { class: 'card-key' }, t.key), h('span', null, titleOf(t)),
          t.work_summary ? h('span', { class: 'muted' }, t.work_summary) : null))) : null);
  }));
  return h('div', null, head, lanes);
}

// ---------- waiting time report ----------
async function renderWaiting() {
  const f = state.filters;
  const params = new URLSearchParams({ window_days: f.window });
  if (f.agingAssignee) params.set('assignee', f.agingAssignee);
  const r = await api(`/aging?${params}`);
  const windowText = f.window === '0' ? 'all time' : `the last ${f.window} days`;
  const maxAvg = Math.max(1, ...r.statuses.map((s) => s.finished_avg_ms ?? 0));

  const head = pageHead('Waiting time', 'How long tickets sit in each status: right now, and on average once they move on.',
    h('div', { class: 'toolbar' },
      personSelect(f.agingAssignee, (v) => { f.agingAssignee = v; refreshView(); }),
      h('select', { 'aria-label': 'Time window', value: f.window, onchange: (e) => { f.window = e.target.value; refreshView(); } },
        h('option', { value: '7' }, 'Last 7 days'),
        h('option', { value: '30' }, 'Last 30 days'),
        h('option', { value: '90' }, 'Last 90 days'),
        h('option', { value: '0' }, 'All time')),
      updatedLabel()));

  const openNow = r.statuses.reduce((a, s) => a + s.current_count, 0);
  const summary = h('div', { class: 'summary-row' },
    h('div', null, h('b', null, openNow), h('span', null, 'open now')),
    h('div', null, h('b', { style: { color: r.stuck.length ? 'var(--hot)' : '' } }, r.stuck.length), h('span', null, 'stuck now')),
    h('div', null, h('b', null, r.closed_count), h('span', null, `done in ${windowText}`)),
    h('div', null, h('b', null, fmtAvg(r.cycle_avg_ms)), h('span', null, 'average start to done')),
    h('div', null, h('b', null, fmtAvg(r.cycle_median_ms)), h('span', null, 'median start to done')));

  const table = h('table', { class: 'data' },
    h('thead', null, h('tr', null,
      h('th', null, 'Status'),
      h('th', { class: 'num' }, 'Waiting now'),
      h('th', { class: 'num hide-sm' }, 'Average wait now'),
      h('th', { class: 'num' }, 'Longest now'),
      h('th', { title: `Across every time a ticket left this status in ${windowText}` }, 'Average time spent'),
      h('th', { class: 'num hide-sm' }, 'Median'),
      h('th', { class: 'num hide-sm' }, 'Stuck after'),
      h('th', { class: 'num' }, 'Stuck'))),
    h('tbody', null, r.statuses.map((s) => h('tr', { class: 'clickable', onclick: () => { state.filters.assignee = f.agingAssignee; location.hash = '#/board'; } },
      h('td', null, statusPill(s.status), s.status.archived ? h('span', { class: 'muted' }, ' (archived)') : null),
      h('td', { class: 'num mono' }, s.current_count),
      h('td', { class: 'num mono hide-sm' }, fmtAvg(s.current_avg_ms)),
      h('td', { class: 'num' }, s.current_max_ms != null ? h('span', { class: `wait ${s.stuck_after_days && s.current_max_ms > s.stuck_after_days * DAY ? 'hot' : ''}` }, fmt(s.current_max_ms)) : h('span', { class: 'muted' }, '–')),
      h('td', null, s.finished_count
        ? h('div', { class: 'hbar', style: { '--status-color': s.status.color }, title: `${s.finished_count} time(s) a ticket left ${s.status.name}` },
            h('i', { style: { width: `${Math.max(3, (s.finished_avg_ms / maxAvg) * 120)}px` } }), h('span', { class: 'wait' }, fmtAvg(s.finished_avg_ms)), h('span', { class: 'muted' }, `× ${s.finished_count}`))
        : h('span', { class: 'muted' }, 'no tickets have left this status yet')),
      h('td', { class: 'num mono hide-sm' }, fmtAvg(s.finished_median_ms)),
      h('td', { class: 'num hide-sm muted' }, s.stuck_after_days ? daysLabel(s.stuck_after_days) : 'never'),
      h('td', { class: 'num' }, s.stuck_count ? h('span', { class: 'stuck-flag' }, s.stuck_count) : h('span', { class: 'muted' }, '0'))))));

  const stuck = h('div', { class: 'panel' },
    h('div', { class: 'panel-head' }, h('h2', null, 'Stuck tickets'), h('span', { class: 'muted' }, 'Over the limit for their current status')),
    r.stuck.length
      ? h('table', { class: 'data' }, h('tbody', null, r.stuck.map((t) => h('tr', { class: 'clickable', onclick: () => openTask(t.key) },
          h('td', null, h('div', { class: 'card-key' }, t.key), h('div', null, titleOf(t))),
          h('td', null, h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, avatar(t.assignee), statusPill(t.status))),
          h('td', { class: 'num' }, waitText(t), h('div', { class: 'muted', style: { fontSize: '11px' } }, `limit ${daysLabel(t.stuck_after_days)}`))))))
      : h('div', { class: 'empty' }, 'Nothing is over its limit.'));

  return h('div', null, head,
    h('div', { class: 'panel', style: { marginBottom: '16px' } }, summary, h('div', { style: { overflowX: 'auto' } }, table),
      h('div', { class: 'panel-body muted', style: { borderTop: '1px solid var(--line)', fontSize: '13px' } },
        `“Waiting now” is open tickets sitting in the status today. “Average time spent” and “Median” cover every time a ticket moved out of the status in ${windowText}. “Start to done” runs from when work on the ticket started.`)),
    stuck);
}

// ---------- people ----------
async function renderPeople() {
  state.users = await api('/users');
  const form = h('form', { class: 'panel-body form-row', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: Object.fromEntries(new FormData(e.target)) });
      e.target.reset(); await loadMeta(); refreshView(); toast('Manager added');
    } catch (err) { fail(err); }
  } },
    h('label', { class: 'field' }, h('span', null, 'Name'), h('input', { type: 'text', name: 'name', required: true })),
    h('label', { class: 'field' }, h('span', null, 'Email'), h('input', { type: 'email', name: 'email', required: true, placeholder: 'name@company.com' })),
    h('label', { class: 'field' }, h('span', null, 'Password'), h('input', { type: 'password', name: 'password', required: true, minlength: '8', autocomplete: 'new-password' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add manager'));

  const rows = state.users.map((u) => h('tr', { style: { opacity: u.active ? 1 : 0.55 } },
    h('td', null, h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, avatar(u),
      h('div', null, h('div', { style: { fontWeight: 500 } }, u.name, u.id === state.me.id ? h('span', { class: 'muted' }, ' (you)') : null),
        h('div', { class: 'muted', style: { fontSize: '12px' } }, u.email)))),
    h('td', { class: 'hide-sm' }, u.role === 'manager' ? 'Manager' : 'Team member', !u.active ? h('div', { class: 'tag' }, 'Deactivated') : null),
    h('td', { class: 'num mono' }, u.open_tasks),
    h('td', null, h('div', { class: 'row-actions' },
      h('button', { class: 'btn sm ghost', onclick: () => editPerson(u) }, 'Edit'),
      u.role === 'manager' ? h('button', { class: 'btn sm ghost', onclick: () => setPassword(u) }, u.has_password ? 'Change password' : 'Set password') : null,
      h('button', { class: `btn sm ghost ${u.active ? 'danger' : ''}`, onclick: async () => {
        if (u.active && !confirm(`Deactivate ${u.name}? Status updates from ${u.email} are ignored until they're reactivated. Their tickets stay as they are.`)) return;
        try { await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }); await loadMeta(); refreshView(); toast(u.active ? `${u.name} deactivated` : `${u.name} reactivated`); } catch (err) { fail(err); }
      } }, u.active ? 'Deactivate' : 'Reactivate')))));

  return h('div', null,
    pageHead('People', 'Team members appear here automatically, named by their git name and email, the first time their Claude Code reports work.'),
    h('div', { class: 'panel', style: { overflowX: 'auto', marginBottom: '16px' } }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Person'), h('th', { class: 'hide-sm' }, 'Role'), h('th', { class: 'num' }, 'Open'), h('th'))),
      h('tbody', null, rows))),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'Add a manager'), h('span', { class: 'muted' }, 'Managers sign in to this dashboard')), form));
}

function editPerson(u) {
  const name = h('input', { type: 'text', value: u.name });
  const role = h('select', { value: u.role }, h('option', { value: 'member' }, 'Team member'), h('option', { value: 'manager' }, 'Manager'));
  modal({
    title: `Edit ${u.name}`,
    sub: `Identified by git email ${u.email}.`,
    body: [h('label', { class: 'field' }, h('span', null, 'Display name'), name, h('small', null, 'Once you rename someone, their git name no longer overrides it.')),
      h('label', { class: 'field' }, h('span', null, 'Role'), role, h('small', null, 'Managers can sign in to this dashboard once they have a password.'))],
    actions: (close) => [h('button', { class: 'btn ghost', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
      try { await api(`/users/${u.id}`, { method: 'PATCH', body: { name: name.value, role: role.value } }); close(); await loadMeta(); if (u.id === state.me.id) renderShellAndRoute(); else refreshView(); toast('Saved'); } catch (err) { fail(err); }
    } }, 'Save')],
  });
}

function setPassword(u) {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', minlength: '8' });
  modal({
    title: `${u.has_password ? 'Change' : 'Set'} password for ${u.name}`,
    sub: 'Managers sign in with their email and this password. At least 8 characters.',
    body: [h('label', { class: 'field' }, h('span', null, 'New password'), pw)],
    actions: (close) => [h('button', { class: 'btn ghost', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: async () => {
      try {
        await api(`/users/${u.id}/password`, { method: 'POST', body: { password: pw.value } });
        close();
        if (u.id === state.me.id) { toast('Password changed. Sign in again.'); renderLogin(); } else { refreshView(); toast('Password saved'); }
      } catch (err) { fail(err); }
    } }, 'Save password')],
  });
}

// ---------- connect ----------
const ALLOW_RULE = 'mcp__plugin_work-tracker_work-tracker__*';
const serverUrl = () => state.publicUrl || location.origin;
const isLoopback = (url) => /^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(url);

async function renderConnect() {
  await loadMeta();
  const s = state.settings;
  const source = state.pluginSource || '<git address of the work-tracking repo>';
  const addCmd = `claude plugin marketplace add ${source}`;
  const installCmd = `claude plugin install work-tracker@work-tracker --config server_url=${serverUrl()} --config team_key=${s.team_key}`;
  const masked = `${s.team_key.slice(0, 8)}${'•'.repeat(16)}`;
  let shown = false;
  const keyEl = h('code', { class: 'code' }, masked);
  const installEl = h('code', { class: 'code' }, installCmd.replace(s.team_key, masked));

  const step = (title, ...body) => h('li', null, h('div', { class: 'step-title' }, title), ...body);

  const tracking = h('form', { class: 'panel-body form-row', onsubmit: async (e) => {
    e.preventDefault();
    try { await api('/settings', { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) }); await loadMeta(); refreshView(); toast('Settings saved'); } catch (err) { fail(err); }
  } },
    h('label', { class: 'field' }, h('span', null, 'Jira projects to track'),
      h('input', { type: 'text', name: 'jira_project_keys', value: s.jira_project_keys.join(', '), placeholder: 'e.g. PROJ, OPS' }),
      h('small', null, 'Only branches with these project keys are tracked, in upper or lower case. Empty: any uppercase key like PROJ-123 counts.')),
    h('button', { class: 'btn', type: 'submit' }, 'Save'));

  return h('div', null,
    pageHead('Connect', 'Each person installs the Work Tracker plugin in Claude Code once. It works in the terminal, the desktop app, and the VS Code and Cursor extensions.'),
    h('div', { class: 'grid-2' },
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Set up a team member')),
        h('div', { class: 'panel-body' },
          isLoopback(serverUrl()) ? h('div', { class: 'warn-box', style: { marginBottom: '14px' } },
            h('b', null, `${serverUrl()} only works on this computer. `),
            'Teammates need the server’s network address: start the server with HOST=0.0.0.0 and PUBLIC_URL set to that address (see the README), then come back here.') : null,
          h('ol', { class: 'steps' },
            step('Add the plugin source (once per computer)', h('code', { class: 'code' }, addCmd),
              h('div', { class: 'row-actions', style: { justifyContent: 'flex-start', marginTop: '6px' } }, h('button', { class: 'btn sm', onclick: () => copy(addCmd, 'Command copied') }, 'Copy'))),
            step('Install it with your team’s address and key', installEl,
              h('div', { class: 'row-actions', style: { justifyContent: 'flex-start', marginTop: '6px' } }, h('button', { class: 'btn sm primary', onclick: () => copy(installCmd, 'Install command copied (includes the team key)') }, 'Copy with key')),
              h('small', { class: 'muted' }, 'To keep the key out of shell history, install without the two --config parts and enter them in Claude Code with /plugin configure work-tracker@work-tracker.')),
            step('Let Claude update the tracker without asking each time',
              h('p', { class: 'muted', style: { marginBottom: '6px' } }, 'Otherwise Claude Code stops for approval on every status update. In Claude Code run ', h('code', null, '/permissions'), ', add this Allow rule, or add it to ', h('code', null, 'permissions.allow'), ' in ', h('code', null, '~/.claude/settings.json'), ':'),
              h('code', { class: 'code' }, ALLOW_RULE),
              h('div', { class: 'row-actions', style: { justifyContent: 'flex-start', marginTop: '6px' } }, h('button', { class: 'btn sm', onclick: () => copy(ALLOW_RULE, 'Rule copied') }, 'Copy'))),
            step('Check git knows who they are', h('code', { class: 'code' }, 'git config --global user.name "Full Name"\ngit config --global user.email name@company.com'),
              h('small', { class: 'muted' }, 'This name and email are how they appear here.')),
            step('Restart Claude Code, then work as usual',
              h('p', { class: 'muted' }, 'When a session is on a branch named with a Jira key, for example ', h('code', null, 'feature/PROJ-123'), ', the ticket appears on the Board with its title from Jira. Claude moves it to review, blocked or done as the work goes, and writes a summary when it’s finished. To check the connection, run ', h('code', null, '/mcp'), ' in Claude Code and look for ', h('code', null, 'plugin:work-tracker:work-tracker'), '.'))))),
      h('div', null,
        h('div', { class: 'panel', style: { marginBottom: '16px' } },
          h('div', { class: 'panel-head' }, h('h2', null, 'Team key')),
          h('div', { class: 'panel-body', style: { display: 'grid', gap: '10px' } },
            keyEl,
            h('div', { class: 'row-actions', style: { justifyContent: 'flex-start' } },
              h('button', { class: 'btn sm', onclick: (e) => { shown = !shown; keyEl.textContent = shown ? s.team_key : masked; installEl.textContent = shown ? installCmd : installCmd.replace(s.team_key, masked); e.target.textContent = shown ? 'Hide' : 'Show'; } }, 'Show'),
              h('button', { class: 'btn sm', onclick: () => copy(s.team_key, 'Team key copied') }, 'Copy'),
              h('button', { class: 'btn sm ghost danger', onclick: async () => {
                if (!confirm('Make a new team key? Everyone’s plugin stops reporting until they reinstall it with the new key.')) return;
                try { await api('/settings/team-key', { method: 'POST' }); await loadMeta(); refreshView(); toast('New team key made'); } catch (err) { fail(err); }
              } }, 'Make a new key')),
            h('small', { class: 'muted' }, 'Anyone with this key can report work under any git email, so share it only with the team.'))),
        h('div', { class: 'panel' },
          h('div', { class: 'panel-head' }, h('h2', null, 'Jira')),
          h('div', { class: 'panel-body' },
            state.jira.configured
              ? h('p', { style: { margin: 0 } }, 'Connected to ', h('b', null, state.jira.base_url), ', read-only. Ticket titles and descriptions load from Jira automatically. Nothing in Jira is ever changed.')
              : h('p', { style: { margin: 0 } }, 'Not connected. Titles come from each person’s Claude instead, when it can read Jira. To load them on the server, set ', h('code', null, 'JIRA_BASE_URL'), ', ', h('code', null, 'JIRA_EMAIL'), ' and ', h('code', null, 'JIRA_API_TOKEN'), ' and restart. A token with read access is enough.'))),
        h('div', { class: 'panel', style: { marginTop: '16px' } }, h('div', { class: 'panel-head' }, h('h2', null, 'What gets tracked')),
          !s.jira_project_keys.length ? h('div', { class: 'warn-box', style: { margin: '14px 16px 0' } }, 'No projects set yet: only uppercase keys in branch names (like PROJ-123) are picked up. Add your Jira project keys to also accept lowercase branch names and ignore everything else.') : null,
          tracking))));
}

// ---------- statuses ----------
async function renderStatuses() {
  await loadMeta();
  const live = activeStatuses();
  const archived = state.statuses.filter((s) => s.archived);
  const def = state.settings.default_stuck_days;

  const save = async (s, patch) => {
    try { await api(`/statuses/${s.id}`, { method: 'PATCH', body: patch }); await loadMeta(); toast(`${patch.name ?? s.name} saved`); refreshView(); } catch (err) { fail(err); refreshView(); }
  };
  const move = async (i, dir) => {
    const ids = live.map((s) => s.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    try { await api('/statuses/reorder', { method: 'POST', body: { ids: [...ids, ...archived.map((s) => s.id)] } }); refreshView(); } catch (err) { fail(err); }
  };
  const catOptions = (value, name) => h('select', { value, name, 'aria-label': 'Category' },
    h('option', { value: 'todo' }, 'To do'), h('option', { value: 'active' }, 'Active'), h('option', { value: 'blocked' }, 'Blocked'), h('option', { value: 'done' }, 'Done'));

  const rows = live.map((s, i) => {
    const cat = catOptions(s.category);
    cat.addEventListener('change', () => save(s, { category: cat.value }));
    return h('tr', { class: 'status-row' },
      h('td', null, h('span', { class: 'reorder' },
        h('button', { 'aria-label': `Move ${s.name} up`, disabled: i === 0, onclick: () => move(i, -1) }, '▲'),
        h('button', { 'aria-label': `Move ${s.name} down`, disabled: i === live.length - 1, onclick: () => move(i, 1) }, '▼'))),
      h('td', null, h('input', { type: 'color', value: s.color, 'aria-label': `${s.name} colour`, onchange: (e) => save(s, { color: e.target.value }) })),
      h('td', null, h('input', { type: 'text', value: s.name, 'aria-label': 'Status name', onchange: (e) => save(s, { name: e.target.value }) })),
      h('td', null, cat),
      h('td', null, s.category === 'done'
        ? h('span', { class: 'muted' }, 'n/a')
        : h('input', { type: 'number', min: '0', step: '0.5', value: s.stuck_after_days ?? '', placeholder: `${def}`, 'aria-label': 'Stuck after days',
            onchange: (e) => save(s, { stuck_after_days: e.target.value === '' ? null : Number(e.target.value) }) })),
      h('td', { class: 'num mono' }, s.task_count),
      h('td', null, h('div', { class: 'row-actions' }, h('button', { class: 'btn sm ghost danger', onclick: () => archiveStatus(s) }, 'Archive'))));
  });

  const addForm = h('form', { class: 'panel-body form-row', onsubmit: async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (fd.stuck_after_days === '') fd.stuck_after_days = null;
    try { await api('/statuses', { method: 'POST', body: fd }); e.target.reset(); await loadMeta(); refreshView(); toast(`${fd.name} added`); } catch (err) { fail(err); }
  } },
    h('label', { class: 'field', style: { flex: '0 0 auto', minWidth: '0' } }, h('span', null, 'Colour'), h('input', { type: 'color', name: 'color', value: '#0ea5e9' })),
    h('label', { class: 'field' }, h('span', null, 'Name'), h('input', { type: 'text', name: 'name', required: true, placeholder: 'e.g. Waiting for client' })),
    h('label', { class: 'field', style: { flex: '0 0 140px', minWidth: '0' } }, h('span', null, 'Category'), catOptions('active', 'category')),
    h('label', { class: 'field', style: { flex: '0 0 150px', minWidth: '0' } }, h('span', null, 'Stuck after (days)'), h('input', { type: 'number', name: 'stuck_after_days', min: '0', step: '0.5', placeholder: `default ${def}` })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Add status'));

  const general = h('form', { class: 'panel-body form-row', onsubmit: async (e) => {
    e.preventDefault();
    try { await api('/settings', { method: 'PATCH', body: Object.fromEntries(new FormData(e.target)) }); await loadMeta(); refreshView(); toast('Settings saved'); } catch (err) { fail(err); }
  } },
    h('label', { class: 'field' }, h('span', null, 'Default “stuck after” (days)'), h('input', { type: 'number', name: 'default_stuck_days', min: '0', step: '0.5', value: def }),
      h('small', null, 'Used by any status without its own limit. 0 turns it off.')),
    h('button', { class: 'btn', type: 'submit' }, 'Save'));

  return h('div', null,
    pageHead('Statuses', 'The tracker’s own statuses, in board order. Claude uses these names when it updates a ticket; Jira’s statuses are not used. Renaming keeps all past history.'),
    h('div', { class: 'panel', style: { overflowX: 'auto', marginBottom: '16px' } }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th'), h('th'), h('th', null, 'Name'), h('th', null, 'Category'),
        h('th', { title: 'A ticket in this status for longer than this is flagged as stuck. Empty uses the default; 0 means never.' }, 'Stuck after (days)'),
        h('th', { class: 'num' }, 'Tickets'), h('th'))),
      h('tbody', null, rows)),
      h('div', { class: 'panel-body muted', style: { borderTop: '1px solid var(--line)', fontSize: '13px' } },
        'A ticket starts in the first ', h('b', null, 'Active'), ' status the first time someone works on it in Claude Code; a ticket parked in a ', h('b', null, 'To do'), ' status moves back to that status when work resumes. ',
        h('b', null, 'Done'), ' statuses close a ticket (Claude must add a work summary) and are left out of waiting times. ', h('b', null, 'Blocked'), ' statuses count toward each person’s blocked total.')),
    h('div', { class: 'panel', style: { marginBottom: '16px' } }, h('div', { class: 'panel-head' }, h('h2', null, 'Add a status')), addForm),
    archived.length ? h('div', { class: 'panel', style: { marginBottom: '16px' } },
      h('div', { class: 'panel-head' }, h('h2', null, 'Archived statuses'), h('span', { class: 'muted' }, 'Hidden from the board and from Claude; kept for history')),
      h('div', { class: 'panel-body', style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } }, archived.map((s) =>
        h('span', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } }, statusPill(s), h('button', { class: 'btn sm ghost', onclick: () => save(s, { archived: false }) }, 'Restore'))))) : null,
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('h2', null, 'General')), general));
}

function archiveStatus(s) {
  const others = activeStatuses().filter((x) => x.id !== s.id);
  const target = h('select', null, others.map((x) => h('option', { value: String(x.id) }, x.name)));
  const doArchive = async (close) => {
    try {
      await api(`/statuses/${s.id}/archive`, { method: 'POST', body: s.task_count ? { move_to: Number(target.value) } : {} });
      close(); await loadMeta(); refreshView(); toast(`${s.name} archived`);
    } catch (err) { fail(err); }
  };
  modal({
    title: `Archive “${s.name}”?`,
    sub: 'It disappears from the board and from Claude’s list of statuses. Past history keeps the name.',
    body: s.task_count ? [h('label', { class: 'field' }, h('span', null, `Move its ${s.task_count} ticket(s) to`), target)] : [],
    actions: (close) => [h('button', { class: 'btn ghost', onclick: close }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => doArchive(close) }, 'Archive status')],
  });
}

// ---------- modal & drawer ----------
function modal({ title, sub, body = [], actions }) {
  const wrap = h('div', { class: 'modal-wrap', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const scrim = h('div', { class: 'scrim' });
  const close = () => { wrap.remove(); scrim.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.append(h('div', { class: 'modal' },
    h('div', { class: 'modal-head' }, h('h2', null, title), sub ? h('p', null, sub) : null),
    h('div', { class: 'modal-body' }, body),
    h('div', { class: 'modal-foot' }, actions(close))));
  document.body.append(scrim, wrap);
  document.addEventListener('keydown', onKey);
  setTimeout(() => wrap.querySelector('input, select, textarea, button.primary')?.focus(), 0);
  return close;
}

function closeDrawer() {
  state.openTaskKey = null;
  $('#drawer')?.remove();
  $('#drawer-scrim')?.remove();
}

async function openTask(key) {
  let t;
  try { t = await api(`/tasks/${encodeURIComponent(key)}`); } catch (err) { return fail(err); }
  state.openTaskKey = t.key;
  $('#drawer')?.remove();
  $('#drawer-scrim')?.remove();

  const { level, frac } = heat(t);
  const now = h('div', { class: 'now-waiting' },
    h('span', { class: `wait ${level}` }, fmt(t.time_in_status_ms)),
    h('span', { class: 'of' }, 'in'), statusPill(t.status),
    level === 'hot' ? h('span', { class: 'stuck-flag' }, 'Stuck') : null,
    h('span', { class: 'muted', style: { width: '100%', fontSize: '12px' } },
      `Since ${dateTime(t.status_changed_at)}`,
      t.stuck_after_days ? ` · limit ${daysLabel(t.stuck_after_days)} (${Math.round(frac * 100)}%)` : '',
      ` · started ${dateTime(t.created_at)}`),
    h('span', { style: { width: '100%', display: 'flex', alignItems: 'center', gap: '8px' } },
      avatar(t.assignee), h('span', null, t.assignee?.name ?? 'Unassigned')));

  const summary = h('div', null, h('p', { class: 'section-label' }, 'Work summary'),
    t.work_summary
      ? h('div', { class: 'summary-box' }, t.work_summary, h('div', { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } }, `Written by Claude, ${dateTime(t.summary_updated_at)}`))
      : h('div', { class: 'muted' }, 'No summary yet. Claude writes one when the ticket is picked up from Jira, and replaces it with what was done at the end.'));

  const description = h('div', null, h('p', { class: 'section-label' }, `Description${t.details_source === 'jira' ? ' (from Jira)' : t.details_source === 'claude' ? ' (via Claude)' : ''}`),
    t.description ? h('div', { class: 'description' }, t.description) : h('div', { class: 'muted' }, t.title ? 'No description in Jira.' : 'Not loaded from Jira yet.'),
    t.details_error ? h('div', { class: 'error-text', style: { marginTop: '6px' } }, t.details_error) : null);

  const total = t.time_by_status.reduce((a, s) => a + s.total_ms, 0) || 1;
  const breakdown = h('div', null, h('p', { class: 'section-label' }, 'Time in each status'),
    h('div', { class: 'stack' }, t.time_by_status.map((s) => h('i', { style: { '--status-color': s.color, width: `${(s.total_ms / total) * 100}%` }, title: `${s.name}: ${fmt(s.total_ms)}` }))),
    h('div', { class: 'stack-legend' }, t.time_by_status.map((s) => h('div', null,
      h('span', { class: 'dot', style: { width: '8px', height: '8px', borderRadius: '50%', background: s.color } }),
      s.name, s.visits > 1 ? h('span', { class: 'muted' }, ` (${s.visits} times)`) : null, s.current ? h('span', { class: 'muted' }, ' · now') : null,
      h('span', { class: 'wait' }, fmt(s.total_ms))))));


  // Timeline, newest first. For a status change, show how long the ticket had been in the previous status.
  const moves = t.events.filter((e) => e.kind === 'created' || e.kind === 'status');
  const stintBefore = new Map();
  moves.forEach((e, i) => { if (i > 0) stintBefore.set(e.id, e.created_at - moves[i - 1].created_at); });
  const describe = (e) => {
    if (e.kind === 'created') return ['Started in ', h('b', null, e.to_status_name)];
    if (e.kind === 'status') return [e.from_status_name, ' → ', h('b', null, e.to_status_name)];
    if (e.kind === 'assigned') return ['Picked up by ', h('b', null, e.to_user_name ?? 'nobody'), e.from_user_name ? ` (was ${e.from_user_name})` : ''];
    if (e.kind === 'summary') return ['Work summary updated'];
    return ['Note'];
  };
  const via = (s) => ({ claude: ' via Claude', hook: ' in Claude Code', web: ' on the dashboard' })[s] ?? '';
  const timeline = h('div', null, h('p', { class: 'section-label' }, 'History'),
    h('ol', { class: 'timeline' }, [...t.events].reverse().map((e) => h('li', null,
      h('span', { class: 'node', style: e.to_status_color ? { borderColor: e.to_status_color } : {} }),
      h('div', null,
        h('div', { class: 'what' }, describe(e)),
        h('div', { class: 'meta' }, e.actor_name ?? 'System', via(e.source), ` · ${dateTime(e.created_at)}`,
          stintBefore.has(e.id) ? h('span', { class: 'stint' }, ` · after ${fmt(stintBefore.get(e.id))} in ${e.from_status_name}`) : null),
        e.note && e.kind !== 'summary' ? h('div', { class: 'note' }, e.note) : null)))));

  const scrim = h('div', { class: 'scrim', id: 'drawer-scrim', onclick: closeDrawer });
  const drawer = h('aside', { class: 'drawer', id: 'drawer', role: 'dialog', 'aria-label': `${t.key} details` },
    h('div', { class: 'drawer-head' },
      jiraLink(t, t.jira_url ? `${t.key} ↗` : t.key),
      h('span', { style: { flex: 1 } }),
      state.jira.configured ? h('button', { class: 'btn sm ghost', onclick: async () => {
        try { await api(`/tasks/${encodeURIComponent(t.key)}/refresh`, { method: 'POST' }); toast('Reloaded from Jira'); openTask(t.key); refreshView(); } catch (err) { fail(err); }
      } }, 'Reload from Jira') : null,
      h('button', { class: 'btn sm ghost danger', onclick: async () => {
        if (!confirm(`Remove ${t.key} and its history from the tracker? Jira is not affected. If someone works on it again it reappears as new.`)) return;
        try { await api(`/tasks/${encodeURIComponent(t.key)}`, { method: 'DELETE' }); closeDrawer(); toast(`${t.key} removed`); refreshView(); } catch (err) { fail(err); }
      } }, 'Remove'),
      h('button', { class: 'btn sm ghost', onclick: closeDrawer, 'aria-label': 'Close' }, 'Close')),
    h('div', { class: 'drawer-body' },
      h('h2', { class: `drawer-title ${t.title ? '' : 'muted'}` }, titleOf(t)),
      now, summary, description, breakdown, timeline));
  document.body.append(scrim, drawer);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.openTaskKey && !$('.modal-wrap')) closeDrawer();
});

// ---------- login ----------
function renderLogin(message) {
  closeDrawer();
  const err = h('div', { class: 'error-text', role: 'alert' }, message ?? '');
  $('#app').replaceChildren(h('div', { class: 'login' }, h('form', { class: 'panel login-card', onsubmit: async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try { await api('/login', { method: 'POST', body: fd }); await start(); } catch (ex) { err.textContent = ex.message; }
  } },
    h('h1', null, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), 'Work Tracker'),
    h('p', null, 'Sign in to see where your team’s Jira tickets stand.'),
    h('label', { class: 'field' }, h('span', null, 'Email'), h('input', { type: 'text', name: 'email', autocomplete: 'username', required: true })),
    h('label', { class: 'field' }, h('span', null, 'Password'), h('input', { type: 'password', name: 'password', autocomplete: 'current-password', required: true })),
    err,
    h('button', { class: 'btn primary', type: 'submit', style: { justifyContent: 'center' } }, 'Sign in'))));
  setTimeout(() => $('.login input')?.focus(), 0);
}

async function signOut() {
  try { await api('/logout', { method: 'POST' }); } catch {}
  renderLogin();
}

function renderShellAndRoute() {
  renderShell();
  route();
}

async function start() {
  try { await loadMeta(); } catch (err) { if (err.message !== 'Signed out') renderLogin(err.message); return; }
  renderShellAndRoute();
}

window.addEventListener('hashchange', () => { if (state.me) { closeDrawer(); route(); } });

// Keep the page current while it's open, without disturbing anyone mid-edit.
setInterval(() => {
  const label = $('#updated');
  if (label && state.lastLoaded) label.textContent = `Updated ${refreshedAgo(state.lastLoaded)}`;
  if (!state.me || document.visibilityState !== 'visible' || !$('#view')) return;
  if ($('.modal-wrap') || $('#drawer')) return;
  const active = document.activeElement;
  if (active && active !== document.body && $('#view').contains(active) && /INPUT|SELECT|TEXTAREA/.test(active.tagName)) return;
  if (Date.now() - (state.lastLoaded ?? 0) >= REFRESH_MS) refreshView();
}, 5000);

start();

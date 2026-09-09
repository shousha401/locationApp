const path = require('path');
// Load .env from THIS app's folder, not the process cwd — so it works the same
// whether started from here, from PM2, or from the preview launcher.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');

const auth = require('./backend/auth');
const users = require('./backend/users');
const inventory = require('./backend/inventory');
const notes = require('./backend/notes');
const requests = require('./backend/requests');
const groups = require('./backend/groups');
const today = require('./backend/today');

const app = express();
app.use(express.json({ limit: '256kb' }));

// Baseline security headers (dependency-free), mirroring valueTool.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// Per-user gate over everything but the login screen. Sets req.user downstream.
app.use(auth.middleware);
app.post('/api/login', auth.login);
app.post('/api/logout', auth.logout);

// Who am I (the page uses role to show/hide the editor controls).
app.get('/api/session', (req, res) => res.json({ username: req.user.username, role: req.user.role }));

// Snapshot health — the page shows "data as of …" and a building/stale banner.
app.get('/api/status', (_req, res) => res.json(inventory.status()));

// Pull from Swarmbox NOW, instead of waiting out the rest of the 15-minute
// cycle. This is the answer to "I scanned it out and the screen still shows
// it": the app is a snapshot, not a live feed, and this is the button that
// makes it agree with the floor on demand.
//
// Rate-limited GLOBALLY rather than per user — the cost lands on Swarmbox, and
// it does not care which of us asked. Kicked off without awaiting, because the
// pull takes 10-15s and a request held open that long just invites a timeout
// somewhere; the page watches /api/status to see it land. refresh() already
// ignores a call made while one is in flight.
let lastManualRefresh = 0;
const MANUAL_REFRESH_MS = 30000;
app.post('/api/refresh', (req, res) => {
  const since = Date.now() - lastManualRefresh;
  if (since < MANUAL_REFRESH_MS) {
    return res.status(429).json({
      error: `Just refreshed — try again in ${Math.ceil((MANUAL_REFRESH_MS - since) / 1000)}s`,
      ...inventory.status(),
    });
  }
  lastManualRefresh = Date.now();
  console.log(`[Inventory] manual refresh requested by ${req.user.username}`);
  inventory.refresh().catch((e) => console.error('[Inventory] manual refresh threw:', e && e.message));
  res.json({ started: true, ...inventory.status() });
});

// Location typeahead. ?q= filters; returns matches + snapshot status.
app.get('/api/locations', (req, res) => {
  res.json({ ...inventory.status(), matches: inventory.searchLocations(req.query.q, 50) });
});

// How full the rack is — total slots, used, free, and the free bins in walking
// order. Every other inventory read describes stock, so none of them can answer
// "where do I put this pallet": an empty bin sends back no rows and simply isn't
// in the snapshot. The rack list lives in backend/slots.js.
app.get('/api/slots', (_req, res) => res.json(inventory.slotCapacity()));

// One location's contents (grouped by item) + its notes/flags.
app.get('/api/location/:code', (req, res) => {
  const loc = inventory.getLocation(req.params.code);
  res.json({ ...loc, note: notes.get(loc.code) });
});

// Notes: any logged-in user may read; editors and admins may write.
// The bare /api/notes lists EVERY location note, so the landing page can show
// the floor everything that's written without them searching location by
// location — viewers' whole job is reading these.
app.get('/api/notes', (_req, res) => res.json({ notes: notes.all() }));
app.get('/api/notes/:code', (req, res) => res.json(notes.get(req.params.code)));
app.put('/api/notes/:code', auth.requireEditor, (req, res) => {
  res.json(notes.set(req.params.code, req.body || {}, req.user.username));
});

// Whole-snapshot aggregates for the dashboard. Served from RAM — costs Swarmbox nothing.
// closedKeepHours rides along so the dashboard's Done list can say when a
// finished job will remove itself without hardcoding the server's clock.
app.get('/api/overview', (_req, res) => {
  reconcileJobs();
  res.json({ ...inventory.overview(groups.list()), closedKeepHours: groups.KEEP_CLOSED_HOURS });
});

// ── Product groups ───────────────────────────────────────────────────────────
// Managers (editor+) name a set of item codes and, per group, a standing weekly
// plan of where it goes on which day; the dashboard aggregates each group from
// the snapshot. Everyone can SEE both — that's the point of the plan: the floor
// reads its instructions instead of waiting for a manager to call them.
const groupResult = (res, r, who, verb) => {
  if (!r) return res.status(404).json({ error: 'No such group' });
  if (r.error) return res.status(400).json({ error: r.error });
  const days = Object.keys(r.plan || {}).length;
  const dates = Object.keys(r.dates || {}).length;
  console.log(`[Groups] ${who} ${verb} '${r.name}' (${r.items.length} items`
    + `${days ? `, notes on ${days} day${days === 1 ? '' : 's'}` : ''}`
    + `${dates ? `, ${dates} one-off date${dates === 1 ? '' : 's'}` : ''}`
    + `${r.note ? ', standing note' : ''}`
    + `${r.family ? ', family' : ''})`);
  res.json(r);
};
// Each group carries `onHand`: does any of its items have stock right now. The
// Today board prints "nothing on hand" beside a task from it, because a job
// whose pallets already left is the single most confusing thing that can sit on
// that board — the floor scanned it out and the task stayed, so it reads as
// undone work. Deliberately ABSENT (not false) until the first snapshot lands:
// an empty index would otherwise mark every group empty and cry wolf on boot.
// Advance jobs against the current snapshot before answering: every group that
// isn't a `family` arms when its stock appears and closes when it ships. Done
// on the read paths because that is the moment the answer is next needed, and
// it only writes when something actually changed. Skipped entirely until a
// snapshot exists — an empty index would read as "everything shipped" and
// close every open job.
function reconcileJobs() {
  if (!inventory.status().ok) return null;
  // The per-item PALLET index, not just the set of codes: a batch job is pinned
  // to pallet ids and has to be able to answer "are mine still here".
  const stock = inventory.itemStock();
  // A snapshot with NOTHING on hand is a Swarmbox glitch until proven
  // otherwise — GT is never actually bare. Advancing jobs against it would
  // close every armed group in one tick (and closes don't undo themselves),
  // so it's treated exactly like having no snapshot at all.
  if (!stock.size) {
    console.warn('[Groups] reconcile skipped: snapshot reads completely empty — not closing anything');
    return null;
  }
  groups.reconcile(stock);
  return stock;
}

app.get('/api/groups', (_req, res) => {
  const stock = reconcileJobs();
  const list = stock
    // `stock` rides along so the board can print WHICH product a task is about
    // and where it sits — the codes it claims, each with its description,
    // pallet count and bins. Only when a snapshot exists, and only the claimed
    // codes: a code the job has already shipped is not what anyone is being
    // sent to pick up. A batch answers for its own pallets, so its task row
    // counts the lot it was split off with rather than everything of that code.
    ? (() => {
      const pinned = groups.pinnedRows();
      return groups.list().map((g) => {
        const only = groups.isBatch(g) ? new Set(g.pallets) : null;
        return { ...g, onHand: groups.onHandNow(g, stock),
          stock: inventory.stockFor(groups.claims(g), only, only ? null : pinned) };
      });
    })()
    : groups.list();
  res.json({ groups: list, days: groups.DAYS });
});

// Put a closed job back to work. Editors only, like every other write here.
app.post('/api/groups/:id/reopen', auth.requireEditor, (req, res) => {
  const r = groups.reopen(req.params.id, req.user.username);
  if (!r) return res.status(404).json({ error: 'No such group' });
  if (r.error) return res.status(400).json({ error: r.error });
  console.log(`[Groups] ${req.user.username} reopened '${r.name}'`);
  res.json(r);
});
// Put ONE product back to work inside an open job, after the job released it
// for having shipped. The small twin of Reopen: the job carried on without this
// code, its stock came back, and a manager is saying it still belongs here —
// rather than untick-save-retick, which is the same thing spelled out long.
app.post('/api/groups/:id/items/:code/restore', auth.requireEditor, (req, res) => {
  const r = groups.restore(req.params.id, req.params.code, req.user.username);
  if (!r) return res.status(404).json({ error: 'No such group' });
  if (r.error) return res.status(400).json({ error: r.error });
  console.log(`[Groups] ${req.user.username} put ${req.params.code} back into '${r.name}'`);
  res.json(r);
});
// Split a batch off a group: the pallets that went into temper on one date are
// a different job from the ones that went in on the next, however much they
// share an item number. The new group is PINNED to those pallet ids; the parent
// keeps claiming the codes, so the next delivery still joins it.
app.post('/api/groups/:id/split', auth.requireEditor, (req, res) => {
  const b = req.body || {};
  const r = groups.split(req.params.id, b, req.user.username);
  if (!r) return res.status(404).json({ error: 'No such group' });
  if (r.error) return res.status(400).json({ error: r.error });
  console.log(`[Groups] ${req.user.username} split '${r.name}' off group ${req.params.id}`
    + ` (${r.pallets.length} pallet${r.pallets.length === 1 ? '' : 's'}: ${r.pallets.join(', ')})`);
  res.json(r);
});
// End a job now — the manual twin of the automatic close-on-ship, for the job
// whose stock came back and is reading under work that already happened.
app.post('/api/groups/:id/close', auth.requireEditor, (req, res) => {
  const r = groups.close(req.params.id, req.user.username);
  if (!r) return res.status(404).json({ error: 'No such group' });
  if (r.error) return res.status(400).json({ error: r.error });
  console.log(`[Groups] ${req.user.username} closed '${r.name}'`);
  res.json(r);
});
app.post('/api/groups', auth.requireEditor, (req, res) => {
  const b = req.body || {};
  groupResult(res, groups.create(b, req.user.username), req.user.username, 'created');
});
app.put('/api/groups/:id', auth.requireEditor, (req, res) => {
  groupResult(res, groups.update(req.params.id, req.body || {}, req.user.username), req.user.username, 'updated');
});
// Clear one weekday's note off a group — the Today board's ✕. Separate from a
// done tick on purpose: this takes the instruction off the week for good.
app.delete('/api/groups/:id/plan/:day', auth.requireEditor, (req, res) => {
  const r = groups.clearDay(req.params.id, req.params.day, req.user.username);
  if (!r) return res.status(404).json({ error: 'No such group' });
  if (r.error) return res.status(400).json({ error: r.error });
  console.log(`[Groups] ${req.user.username} cleared ${r.day} on '${r.group.name}' ('${r.cleared}')`);
  res.json(r.group);
});

app.delete('/api/groups/:id', auth.requireEditor, (req, res) => {
  const g = groups.remove(req.params.id);
  if (!g) return res.status(404).json({ error: 'No such group' });
  console.log(`[Groups] ${req.user.username} deleted '${g.name}'`);
  res.json({ ok: true, removed: g.name });
});

// ── Today board ──────────────────────────────────────────────────────────────
// What's been checked off, and the manager's note for the day. The date always
// comes from the browser — the board is read on the floor, so "today" is the
// viewer's today, not the server's.
app.get('/api/today', (req, res) => {
  const date = today.isDate(req.query.date) ? req.query.date : today.todayLocal();
  const from = today.isDate(req.query.from) ? req.query.from : date;
  const to = today.isDate(req.query.to) ? req.query.to : date;
  res.json({
    date,
    done: today.doneFor(date),
    doneRange: today.doneRange(from, to),
    notes: today.notesRange(from, to),
  });
});

// Anyone signed in may tick a task off — the people doing the work on the floor
// are viewers, and a board only they can read but not check off is a board
// nobody keeps current.
app.post('/api/today/done', (req, res) => {
  const b = req.body || {};
  const r = today.setDone(b.date, b.groupId, !!b.done, req.user.username);
  if (r.error) return res.status(400).json({ error: r.error });
  const g = groups.get(b.groupId);
  console.log(`[Today] ${req.user.username} ${r.done ? 'checked off' : 'un-checked'} `
    + `'${g ? g.name : r.groupId}' for ${r.date}`);
  res.json(r);
});

// The day's note: everybody reads, editors write.
app.put('/api/today/note/:date', auth.requireEditor, (req, res) => {
  const text = (req.body && req.body.text) || '';
  if (String(text).length > today.MAX_NOTE) {
    return res.status(400).json({ error: `Keep it under ${today.MAX_NOTE} characters` });
  }
  const r = today.setNote(req.params.date, text, req.user.username);
  if (r.error) return res.status(400).json({ error: r.error });
  console.log(`[Today] ${req.user.username} ${r.text ? 'wrote' : 'cleared'} the note for ${r.date}`
    + `${r.text ? `: ${r.text.slice(0, 80)}` : ''}`);
  res.json(r);
});

// ── Build-requests channel ───────────────────────────────────────────────────
// The app's feedback loop: any signed-in user (viewers included — that's Clay)
// writes what they want the app to show; the build side reads the thread and
// answers in it, either signed in as admin or over the X-Api-Key lane (auth.js).
app.get('/api/requests', (_req, res) => res.json({ messages: requests.list() }));

app.post('/api/requests', (req, res) => {
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) return res.status(400).json({ error: 'Write something first' });
  if (text.length > requests.MAX_LEN) {
    return res.status(400).json({ error: `Keep it under ${requests.MAX_LEN} characters` });
  }
  // Key-authenticated posts may label themselves (e.g. 'eslam'); session posts
  // are always attributed to the session user.
  const author = req.user.username === 'api' && req.body && req.body.author
    ? String(req.body.author).slice(0, 40) : req.user.username;
  const msg = requests.add(author, text);
  console.log(`[Requests] #${msg.id} from ${author}: ${text.slice(0, 80)}`);
  res.json(msg);
});

app.patch('/api/requests/:id', auth.requireAdmin, (req, res) => {
  const msg = requests.setDone(req.params.id, !!(req.body && req.body.done), req.user.username);
  if (!msg) return res.status(404).json({ error: 'No such message' });
  res.json(msg);
});

// ── User management (admin only) ─────────────────────────────────────────────
// Admins add people, set and reset passwords, change roles, and revoke access.
// Two invariants worth stating out loud:
//   1. The last admin can't be deleted or demoted — user management exists only
//      here and in the host CLI, so losing every admin would strand the app.
//   2. Any change to a user revokes their live sessions immediately, so removing
//      or demoting someone takes effect now rather than whenever their cookie
//      happens to expire.
const ROLE_LIST = ['viewer', 'editor', 'admin'];
const validRole = (r) => ROLE_LIST.includes(r);
const cleanName = (s) => String(s || '').trim().toLowerCase();
const badPassword = (p) => !p || String(p).length < 4;

app.get('/api/users', auth.requireAdmin, (_req, res) => {
  res.json({ users: users.list(), roles: ROLE_LIST });
});

app.post('/api/users', auth.requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  const name = cleanName(username);
  if (!name) return res.status(400).json({ error: 'Username is required' });
  if (badPassword(password)) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  if (!validRole(role)) return res.status(400).json({ error: 'Role must be viewer, editor or admin' });
  if (users.exists(name)) return res.status(409).json({ error: `User '${name}' already exists` });
  const rec = users.upsert(name, password, role);
  console.log(`[Users] ${req.user.username} created '${rec.username}' (${rec.role})`);
  res.json(rec);
});

app.patch('/api/users/:username', auth.requireAdmin, (req, res) => {
  const name = cleanName(req.params.username);
  const current = users.get(name);
  if (!current) return res.status(404).json({ error: 'No such user' });
  const { password, role } = req.body || {};
  let rec = null;

  if (role !== undefined) {
    if (!validRole(role)) return res.status(400).json({ error: 'Role must be viewer, editor or admin' });
    if (current.role === 'admin' && role !== 'admin' && users.countAdmins() === 1) {
      return res.status(409).json({ error: 'Cannot demote the last admin' });
    }
    rec = users.setRole(name, role);
  }
  if (password !== undefined) {
    if (badPassword(password)) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    rec = users.setPassword(name, password);
  }
  if (!rec) return res.status(400).json({ error: 'Nothing to update' });

  const killed = auth.revokeUser(name);
  console.log(`[Users] ${req.user.username} updated '${name}' — ${killed} session(s) revoked`);
  res.json(rec);
});

app.delete('/api/users/:username', auth.requireAdmin, (req, res) => {
  const name = cleanName(req.params.username);
  const current = users.get(name);
  if (!current) return res.status(404).json({ error: 'No such user' });
  if (current.role === 'admin' && users.countAdmins() === 1) {
    return res.status(409).json({ error: 'Cannot remove the last admin' });
  }
  users.remove(name);
  const killed = auth.revokeUser(name);
  console.log(`[Users] ${req.user.username} removed '${name}' — ${killed} session(s) revoked`);
  res.json({ ok: true, removed: name });
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.use(express.static(PUBLIC_DIR));

// Terminal error handler — never leak a stack trace or path.
app.use((err, _req, res, _next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error('[locationApp] unhandled error:', err && err.message);
  res.status((err && err.status) || 500).json({ error: 'Server error' });
});

// 3005 = next free port in the fleet (3002 clayTool, 3003 formulation,
// 3004 valueTool, 3010 CMP Maintenance are all taken on CMP-APP02).
const PORT = Number(process.env.PORT) || 3005;
app.listen(PORT, () => {
  if (users.list().length === 0) {
    console.warn('[locationApp] NO USERS EXIST — nobody can log in yet. Create one:');
    console.warn('             node scripts/add-user.js <username> <password> <viewer|editor>');
  }
  console.log(`[locationApp] live location inventory on http://localhost:${PORT}`);
  // Kick off the first snapshot pull + the periodic refresh loop. The page shows a
  // "building…" state until the first pull lands (~20s).
  inventory.start();
});

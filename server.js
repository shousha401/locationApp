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

// Location typeahead. ?q= filters; returns matches + snapshot status.
app.get('/api/locations', (req, res) => {
  res.json({ ...inventory.status(), matches: inventory.searchLocations(req.query.q, 50) });
});

// One location's contents (grouped by item) + its notes/flags.
app.get('/api/location/:code', (req, res) => {
  const loc = inventory.getLocation(req.params.code);
  res.json({ ...loc, note: notes.get(loc.code) });
});

// Notes: any logged-in user may read; editors and admins may write.
app.get('/api/notes/:code', (req, res) => res.json(notes.get(req.params.code)));
app.put('/api/notes/:code', auth.requireEditor, (req, res) => {
  res.json(notes.set(req.params.code, req.body || {}, req.user.username));
});

// Whole-snapshot aggregates for the dashboard. Served from RAM — costs Swarmbox nothing.
app.get('/api/overview', (_req, res) => res.json(inventory.overview()));

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

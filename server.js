const path = require('path');
// Load .env from THIS app's folder, not the process cwd — so it works the same
// whether started from here, from PM2, or from the preview launcher.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');

const auth = require('./backend/auth');
const users = require('./backend/users');
const inventory = require('./backend/inventory');
const notes = require('./backend/notes');

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

// Notes: any logged-in user may read; only editors may write.
app.get('/api/notes/:code', (req, res) => res.json(notes.get(req.params.code)));
app.put('/api/notes/:code', auth.requireEditor, (req, res) => {
  res.json(notes.set(req.params.code, req.body || {}, req.user.username));
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

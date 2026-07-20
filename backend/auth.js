// auth.js — per-user login with roles, in front of the whole app (pages AND API).
//
// Extends valueTool's single-password gate into named accounts: the session now
// remembers WHO you are and your ROLE, so read-only viewers and read/write editors
// share one app. Same minimal, dependency-free approach otherwise:
//   - HttpOnly session cookie, in-memory sessions (a restart logs everyone out —
//     fine for a LAN tool), 12h sliding expiry.
//   - Everything except the login screen requires a session, including /api/*,
//     because the inventory JSON is the sensitive part.
//   - Write routes (editing notes/flags) additionally require the `editor` role.

const crypto = require('crypto');
const users = require('./users');

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS) || 12 * 60 * 60 * 1000; // 12h sliding
const COOKIE = 'loc_session';
const FAIL_DELAY_MS = 600; // slow down guessing without a lockout table

const sessions = new Map(); // token -> { exp, username, role }

function readToken(req) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

function prune() {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.exp <= now) sessions.delete(t);
}

// Returns the live session (and slides its expiry) or null.
function currentUser(req) {
  const token = readToken(req);
  const s = token && sessions.get(token);
  if (s && s.exp > Date.now()) {
    s.exp = Date.now() + SESSION_TTL_MS; // sliding expiry
    return { token, username: s.username, role: s.role };
  }
  if (token) sessions.delete(token);
  return null;
}

// Gate. Exemptions: the login page and the login call itself.
function middleware(req, res, next) {
  if (req.path === '/login.html' || req.path === '/api/login') return next();
  const u = currentUser(req);
  if (u) {
    req.user = { username: u.username, role: u.role };
    return next();
  }
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth required' });
  // Only same-site relative paths in ?next — a full URL would be an open redirect.
  const dest = req.originalUrl && req.originalUrl.startsWith('/') && !req.originalUrl.startsWith('//')
    ? req.originalUrl : '/';
  res.redirect('/login.html?next=' + encodeURIComponent(dest));
}

// POST /api/login { username, password } → session cookie.
function login(req, res) {
  const username = String((req.body && req.body.username) || '');
  const password = String((req.body && req.body.password) || '');
  const u = users.verify(username, password);
  if (!u) {
    setTimeout(() => res.status(401).json({ error: 'Wrong username or password' }), FAIL_DELAY_MS);
    return;
  }
  prune();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { exp: Date.now() + SESSION_TTL_MS, username: u.username, role: u.role });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  res.json({ ok: true, username: u.username, role: u.role });
}

// POST /api/logout → drop the session.
function logout(req, res) {
  const token = readToken(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
}

// Roles are ranked, so a guard means "at least this role": an admin passes every
// editor-gated route without needing to be listed everywhere.
const RANK = { viewer: 0, editor: 1, admin: 2 };
const rankOf = (role) => (RANK[role] == null ? 0 : RANK[role]);

// Route guard factory. Mount AFTER `middleware`, so req.user is set.
function requireRole(min) {
  return (req, res, next) => {
    if (req.user && rankOf(req.user.role) >= rankOf(min)) return next();
    return res.status(403).json({ error: `${min} role required` });
  };
}
const requireEditor = requireRole('editor');
const requireAdmin = requireRole('admin');

// Drop every session belonging to a user. Without this, "take away access" would
// be a lie: a removed or demoted user's cookie would keep working — with their OLD
// role, since the session caches it — until the 12h sliding expiry ran out.
function revokeUser(username) {
  const u = String(username || '').trim().toLowerCase();
  let killed = 0;
  for (const [token, s] of sessions) {
    if (s.username === u) { sessions.delete(token); killed++; }
  }
  return killed;
}

module.exports = {
  middleware, login, logout, currentUser,
  requireRole, requireEditor, requireAdmin, revokeUser,
};

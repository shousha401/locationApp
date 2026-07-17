// users.js — the app's user store (per-user login with a role).
//
// Unlike valueTool's single shared APP_PASSWORD, this app needs named users so we
// can tell viewers from editors. Stored on disk (data/users.json, gitignored),
// passwords hashed with scrypt + per-user salt — never in plaintext, never in git.
//
// There is no self-service signup: an admin creates accounts from the CLI
//   node scripts/add-user.js <username> <password> <viewer|editor>
// so the set of people who can touch the app is deliberate and small.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'data', 'users.json');
const ROLES = new Set(['viewer', 'editor']);

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Users] load failed:', e.message);
    return [];
  }
}

function persist(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
}

const normRole = (r) => (ROLES.has(r) ? r : 'viewer');
const normUser = (u) => String(u || '').trim().toLowerCase();
const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 64).toString('hex');

// Create or update a user. Returns the stored record (without exposing the hash).
function upsert(username, password, role) {
  username = normUser(username);
  if (!username || !password) throw new Error('username and password are both required');
  const list = load();
  const salt = crypto.randomBytes(16).toString('hex');
  const rec = { username, salt, hash: hash(password, salt), role: normRole(role), updatedAt: new Date().toISOString() };
  const i = list.findIndex((u) => u.username === username);
  if (i >= 0) list[i] = rec; else list.push(rec);
  persist(list);
  return { username: rec.username, role: rec.role, updatedAt: rec.updatedAt };
}

// Verify a login. Returns { username, role } on success, null otherwise.
// Constant-time compare so a wrong password and a wrong username look the same.
function verify(username, password) {
  username = normUser(username);
  const u = load().find((x) => x.username === username);
  if (!u) {
    // Still burn a hash so timing doesn't reveal whether the username exists.
    crypto.scryptSync(String(password), 'decoy-salt', 64);
    return null;
  }
  const a = Buffer.from(hash(password, u.salt), 'hex');
  const b = Buffer.from(u.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { username: u.username, role: normRole(u.role) };
}

function list() {
  return load().map((u) => ({ username: u.username, role: normRole(u.role), updatedAt: u.updatedAt || null }));
}

function remove(username) {
  username = normUser(username);
  const l = load();
  const n = l.filter((u) => u.username !== username);
  if (n.length === l.length) return false;
  persist(n);
  return true;
}

module.exports = { upsert, verify, list, remove, ROLES: [...ROLES] };

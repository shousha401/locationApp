#!/usr/bin/env node
// add-user.js — create or update a login.
//   node scripts/add-user.js <username> <password> [viewer|editor|admin]
//   node scripts/add-user.js --list
//   node scripts/add-user.js --remove <username>
//
// Role defaults to viewer. Re-running with an existing username resets that user's
// password and role. Users live in data/users.json (gitignored).

require('dotenv').config();
const users = require('../backend/users');

const [, , a, b, c] = process.argv;

if (a === '--list') {
  const list = users.list();
  if (!list.length) { console.log('No users yet.'); process.exit(0); }
  for (const u of list) console.log(`${u.role.padEnd(6)}  ${u.username}`);
  process.exit(0);
}

if (a === '--remove') {
  if (!b) { console.error('Usage: node scripts/add-user.js --remove <username>'); process.exit(1); }
  console.log(users.remove(b) ? `Removed '${b}'.` : `No such user '${b}'.`);
  process.exit(0);
}

if (!a || !b) {
  console.error('Usage: node scripts/add-user.js <username> <password> [viewer|editor|admin]');
  console.error('       node scripts/add-user.js --list');
  console.error('       node scripts/add-user.js --remove <username>');
  process.exit(1);
}

const rec = users.upsert(a, b, c || 'viewer');
console.log(`Saved user '${rec.username}' with role '${rec.role}'.`);

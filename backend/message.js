// message.js — one global "message from the manager", shown on the dashboard.
//
// Editors and admins write it; everyone (viewers included) reads it. It's a single
// message, not a thread — the latest one replaces the last. This replaced the
// per-group weekly move schedule: managers wanted to just leave a note for the
// floor, not maintain a destination per product per weekday.
//
// Stored on disk (data/manager-message.json, gitignored).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'manager-message.json');
const MAX_LEN = 2000;

let rec = { text: '', updatedBy: null, updatedAt: null };

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object') {
      rec = { text: String(j.text || ''), updatedBy: j.updatedBy || null, updatedAt: j.updatedAt || null };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Message] load failed:', e.message);
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(rec, null, 2));
  } catch (e) {
    console.error('[Message] save failed:', e.message);
  }
}

load();

const get = () => ({ ...rec });

function set(text, who) {
  rec = {
    text: String(text == null ? '' : text).slice(0, MAX_LEN),
    updatedBy: who || null,
    updatedAt: new Date().toISOString(),
  };
  persist();
  return get();
}

module.exports = { get, set, MAX_LEN };

// notes.js — the app's own annotation layer over the (read-only) Swarmbox feed.
//
// Editors attach a freeform note and/or status flags to a LOCATION. Swarmbox is the
// system of record for what's physically there; this is the human context on top —
// "reserved for the Tuesday order", "pallet 3 is damaged", "recount pending". It
// never touches Swarmbox. Viewers see it; only editors change it (enforced at the
// route, see auth.requireEditor).
//
// Per location code. Stored on disk (data/location-notes.json, gitignored).

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'location-notes.json');

// The fixed flag vocabulary. Keep it small and shared with the UI.
const FLAGS = ['reserved', 'damaged', 'needs_recount', 'do_not_ship'];

let map = new Map(); // code -> { code, note, flags:{...}, updatedBy, updatedAt }

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (Array.isArray(arr)) map = new Map(arr.map((r) => [r.code, r]));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Notes] load failed:', e.message);
    map = new Map();
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify([...map.values()], null, 2));
  } catch (e) {
    console.error('[Notes] save failed:', e.message);
  }
}

load();

const empty = (code) => ({ code, note: '', flags: {}, updatedBy: null, updatedAt: null });

function cleanFlags(f) {
  const out = {};
  for (const k of FLAGS) if (f && f[k]) out[k] = true;
  return out;
}

const isBlank = (r) => !r.note && Object.keys(r.flags).length === 0;

function get(code) {
  code = String(code || '').trim();
  return map.get(code) || empty(code);
}

// Upsert. Fields left undefined are preserved. Clearing note AND all flags
// deletes the record (so a location with nothing on it isn't kept forever).
function set(code, patch, who) {
  code = String(code || '').trim();
  if (!code) return null;
  const prev = map.get(code) || { code, note: '', flags: {} };
  const next = {
    code,
    note: patch.note !== undefined ? String(patch.note).slice(0, 2000) : prev.note,
    flags: patch.flags !== undefined ? cleanFlags(patch.flags) : (prev.flags || {}),
    updatedBy: who || null,
    updatedAt: new Date().toISOString(),
  };
  if (isBlank(next)) {
    map.delete(code);
    persist();
    return empty(code);
  }
  map.set(code, next);
  persist();
  return next;
}

const all = () => [...map.values()];

module.exports = { get, set, all, FLAGS };

// groups.js — manager-named product groups: "Organic 85s", "Grassfed", whatever
// the floor actually calls things. A group is just a name plus a list of item
// codes; the dashboard aggregates the snapshot across each group so managers
// can watch a family of products as one line instead of fifteen.
//
// A group also carries a WEEKLY PLAN: which day it moves and where to. That is
// the standing instruction the floor reads off the dashboard instead of waiting
// for a manager to phone it in — so it repeats every week by design. A dated
// schedule would go blank the moment nobody re-entered it, which is exactly the
// failure this is meant to remove.
//
// Separately, a group can carry ONE-OFF DATES: a note tied to one exact
// calendar date that does NOT repeat — for the thing that happens once, not
// every week (a special pickup on the 15th, say). This is deliberately a
// second, independent field from `plan`, not a replacement for it: existing
// groups' weekly instructions keep working exactly as before.
//
// App-owned, like notes: stored on disk (data/product-groups.json, gitignored),
// never touches Swarmbox. Editors and admins manage them; everyone sees them.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'product-groups.json');
const MAX_NAME = 60;
const MAX_ITEMS = 300;
const MAX_NOTE = 200;
const MAX_DATES = 366; // a year's worth of one-off notes is plenty; a safety cap, not a product limit
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let groups = []; // [{ id, name, items:[codes], plan:{day:dest}, dates:{date:note}, updatedBy, updatedAt }]

function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Groups] load failed:', e.message);
    return; // first run or unreadable — start empty, never overwrite on a guess
  }
  try {
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // tolerate a BOM
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) groups = arr;
    else console.error('[Groups] load failed: file is not an array');
  } catch (e) {
    console.error('[Groups] load failed:', e.message);
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(groups, null, 2));
  } catch (e) {
    console.error('[Groups] save failed:', e.message);
  }
}

load();

const cleanName = (s) => String(s || '').trim().slice(0, MAX_NAME);
// Item codes as they appear in Swarmbox ('062065'); dedupe, drop blanks.
const cleanItems = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
  .map((x) => String(x || '').trim()).filter(Boolean))].slice(0, MAX_ITEMS);

// The weekly plan is a free-text NOTE per day: { mon:'ship AM', wed:'recount' }.
// (It used to be a move destination; managers asked for a plain note instead.)
// Days with nothing are dropped rather than stored blank, so "has a note" is just
// a key check.
function cleanPlan(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const d of DAYS) {
    const v = String(obj[d] == null ? '' : obj[d]).trim().slice(0, MAX_NOTE);
    if (v) out[d] = v;
  }
  return out;
}

// One-off dates: a free-text NOTE per exact calendar date, same shape as the
// weekly plan but keyed by YYYY-MM-DD instead of a weekday — so it applies
// once, not every week. Same "blank drops the key" rule as cleanPlan.
function cleanDates(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [d, v] of Object.entries(obj)) {
    if (!DATE_RE.test(d) || Object.keys(out).length >= MAX_DATES) continue;
    const text = String(v == null ? '' : v).trim().slice(0, MAX_NOTE);
    if (text) out[d] = text;
  }
  return out;
}

const list = () => groups.slice();
const get = (id) => groups.find((g) => g.id === Number(id)) || null;
const nameTaken = (name, exceptId) => groups.some(
  (g) => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase());

function create(name, items, plan, dates, who) {
  name = cleanName(name);
  items = cleanItems(items);
  if (!name) return { error: 'Group needs a name' };
  if (!items.length) return { error: 'Pick at least one product' };
  if (nameTaken(name, null)) return { error: `A group called '${name}' already exists` };
  const id = groups.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  const rec = { id, name, items, plan: cleanPlan(plan), dates: cleanDates(dates),
    updatedBy: who || null, updatedAt: new Date().toISOString() };
  groups.push(rec);
  persist();
  return rec;
}

function update(id, patch, who) {
  const g = get(id);
  if (!g) return { error: 'No such group' };
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (!name) return { error: 'Group needs a name' };
    if (nameTaken(name, g.id)) return { error: `A group called '${name}' already exists` };
    g.name = name;
  }
  if (patch.items !== undefined) {
    const items = cleanItems(patch.items);
    if (!items.length) return { error: 'Pick at least one product' };
    g.items = items;
  }
  // An all-blank plan/dates is a legitimate edit — a manager clearing it — so
  // these replace rather than merge. Omitting a field entirely leaves it alone.
  if (patch.plan !== undefined) g.plan = cleanPlan(patch.plan);
  if (patch.dates !== undefined) g.dates = cleanDates(patch.dates);
  g.updatedBy = who || null;
  g.updatedAt = new Date().toISOString();
  persist();
  return g;
}

// Clear ONE weekday's note, leaving the rest of the week alone. The Today board
// deletes through here (its ✕), so checking a task off for today and taking the
// instruction off the week for good stay two different acts.
function clearDay(id, day, who) {
  const g = get(id);
  if (!g) return null;
  day = String(day || '').toLowerCase();
  if (!DAYS.includes(day)) return { error: 'Not a day of the week' };
  if (!g.plan || !g.plan[day]) return { error: 'Nothing on that day' };
  const was = g.plan[day];
  delete g.plan[day];
  g.updatedBy = who || null;
  g.updatedAt = new Date().toISOString();
  persist();
  return { group: g, day, cleared: was };
}

function remove(id) {
  const g = get(id);
  if (!g) return null;
  groups = groups.filter((x) => x.id !== g.id);
  persist();
  return g;
}

module.exports = { list, get, create, update, clearDay, remove, DAYS };

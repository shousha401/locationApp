// groups.js — manager-named product groups: "Organic 85s", "Grassfed", whatever
// the floor actually calls things. A group is just a name plus a list of item
// codes; the dashboard aggregates the snapshot across each group so managers
// can watch a family of products as one line instead of fifteen.
//
// A group can carry a STANDING NOTE (`note`): the job that has to happen every
// day this group is handled, with no date on it at all. The Today board puts it
// up every morning with its own ✓, and because every done-tick is dated, that
// tick clears overnight by itself — so it comes back tomorrow without anyone
// re-entering it. Use it for the rule; use `dates` below for the one-off.
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

// How long a dated note is kept after its day has passed.
//
// Nothing used to drop these, so a group given a new date every week grew a
// permanent list of finished jobs — and the editor showed all of them, which
// reads as work still outstanding. (It went unnoticed while a save silently
// wiped the whole map; fixing that turned an accidental purge into real
// accumulation.) Sits between today.js's two clocks: ticks at 21 days, day
// notes at 120. Future dates are never touched — writing next month's pickup
// today is the normal way this gets used.
const KEEP_DATE_DAYS = 30;
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

// Server-local cutoff, used only to decide what has aged out. Dates are ISO, so
// a string compare is a date compare.
function cutoff(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Drop dated notes whose day is more than KEEP_DATE_DAYS behind us. Returns the
// count so the caller can skip a pointless rewrite of the file.
function pruneDates() {
  const cut = cutoff(KEEP_DATE_DAYS);
  let dropped = 0;
  for (const g of groups) {
    if (!g.dates) continue;
    for (const d of Object.keys(g.dates)) {
      if (d < cut) { delete g.dates[d]; dropped++; }
    }
  }
  return dropped;
}

load();
// Boot is the one moment a long-lived process is guaranteed to re-read the
// clock, so an install that sits untouched for a month still tidies itself.
// Every write prunes too (see create/update), the same way today.js does.
if (pruneDates()) persist();

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

// The group's STANDING note: the job that has to happen every day this group is
// handled — "check the temp log on every pallet". It carries no date at all,
// which is the whole difference from `dates`: the Today board repeats it every
// morning, and the done-tick (which is always dated) clears it overnight on its
// own. Blank removes it, same rule as the other two.
const cleanNote = (s) => String(s == null ? '' : s).trim().slice(0, MAX_NOTE);

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

// ── One-off jobs ─────────────────────────────────────────────────────────────
// A group matches stock by ITEM CODE and nothing else — not a pallet, not a
// serial, not a receipt date. That is right for a product family ("Grassfed
// beef" should pick up the next delivery), and wrong for a job ("Bellies for
// bacon" is this week's batch). Without a way to tell them apart, shipping a
// job out empties its group and the NEXT delivery of the same code silently
// rejoins it, putting a finished job back in front of the floor.
//
// `oneOff` marks the second kind. Two bits of state drive it:
//   seenStock — armed. A one-off created before its pallets land must not close
//               on the spot merely for never having had any.
//   closedAt  — shipped. Once armed and then empty, the job is over: it stops
//               matching stock and drops off the board, until someone reopens
//               it by hand. Nothing reopens itself, because "the code came back"
//               is exactly the event this exists to ignore.
function reconcile(hasStock) {
  let changed = false;
  for (const g of groups) {
    if (!g.oneOff || g.closedAt) continue;
    const on = g.items.some((c) => hasStock.has(c));
    if (on && !g.seenStock) { g.seenStock = true; changed = true; }
    else if (!on && g.seenStock) { g.closedAt = new Date().toISOString(); changed = true; }
  }
  if (changed) persist();
  return changed;
}

// Put a closed job back to work — and re-arm it, so it has to see its stock
// again before it can close a second time.
function reopen(id, who) {
  const g = get(id);
  if (!g) return null;
  if (!g.closedAt) return { error: 'That job is not closed' };
  delete g.closedAt;
  delete g.seenStock;
  g.updatedBy = who || null;
  g.updatedAt = new Date().toISOString();
  persist();
  return g;
}

const list = () => groups.slice();
const get = (id) => groups.find((g) => g.id === Number(id)) || null;
const nameTaken = (name, exceptId) => groups.some(
  (g) => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase());

// Takes a fields object rather than a row of positional arguments — there are
// six of them now, and `create(name, items, plan, dates, note, oneOff, who)` is
// a bug waiting for someone to transpose two. Mirrors update(id, patch, who).
function create(fields, who) {
  const f = fields || {};
  const name = cleanName(f.name);
  const items = cleanItems(f.items);
  if (!name) return { error: 'Group needs a name' };
  if (!items.length) return { error: 'Pick at least one product' };
  if (nameTaken(name, null)) return { error: `A group called '${name}' already exists` };
  const id = groups.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  const rec = { id, name, items, plan: cleanPlan(f.plan), dates: cleanDates(f.dates),
    updatedBy: who || null, updatedAt: new Date().toISOString() };
  const standing = cleanNote(f.note);
  if (standing) rec.note = standing; // absent rather than empty, so `g.note` alone answers "has one"
  if (f.oneOff) rec.oneOff = true;
  groups.push(rec);
  pruneDates();
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
  if (patch.note !== undefined) {
    const standing = cleanNote(patch.note);
    if (standing) g.note = standing;
    else delete g.note; // clearing the box is how a manager retires a standing job
  }
  // Only a real change of kind resets the job state — the editor sends `oneOff`
  // on every save, and re-saving a closed job to fix its name must not quietly
  // reopen it.
  if (patch.oneOff !== undefined && !!patch.oneOff !== !!g.oneOff) {
    if (patch.oneOff) g.oneOff = true;
    else delete g.oneOff;
    delete g.seenStock;
    delete g.closedAt;
  }
  g.updatedBy = who || null;
  g.updatedAt = new Date().toISOString();
  pruneDates();
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

module.exports = { list, get, create, update, clearDay, remove, reconcile, reopen, DAYS };

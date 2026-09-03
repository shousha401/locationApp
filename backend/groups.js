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

// How long a CLOSED job sits in the dashboard's Done list before it deletes
// itself. ONE DAY: long enough to see what shipped and to catch a wrong close
// with Reopen on the same shift or the next one, short enough that a warehouse
// finishing several jobs a day never opens the dashboard to a wall of work that
// is already done. (It was a week, and a week of closes turned out to be most
// of the group list.) The ✕ on the row still deletes one sooner by hand.
//
// Measured in HOURS off the actual timestamp, not in whole calendar days: at
// this length "yesterday" is the difference between three hours and twenty-
// seven, and a date-only comparison would quietly round it to either.
//
// Reusing a dead group's id (create() hands out max+1) can't resurrect its
// done-ticks in practice: ids only come back around when the highest-numbered
// groups are the ones deleted, a closed job can't be ticked at all, and every
// tick is keyed by DATE — so a new group would have to be given a note
// back-dated onto the very day its predecessor was ticked.
const KEEP_CLOSED_HOURS = 24;
const MAX_PALLETS = 500;
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

let groups = []; // [{ id, name, items:[codes], plan:{day:dest}, dates:{date:note},
                 //    family?, seenStock?, seenItems?:[codes], left?:{code:when},
                 //    closedAt?, closedBy?, updatedBy, updatedAt }]

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

// Drop closed jobs that closed more than KEEP_CLOSED_HOURS ago. Called from
// boot and from reconcile() — NEVER from create/update, which hold a reference
// to one specific group: pruning under an edit could delete the very group
// being saved and persist without it.
function pruneClosed() {
  const cut = Date.now() - KEEP_CLOSED_HOURS * 3600000;
  let dropped = 0;
  groups = groups.filter((g) => {
    if (!g.closedAt) return true;
    const at = Date.parse(g.closedAt);
    // A stamp we can't read is not a licence to delete somebody's group —
    // keep it and let a person decide with the row's ✕.
    if (!Number.isFinite(at) || at > cut) return true;
    console.log(`[Groups] closed job '${g.name}' aged out (closed ${String(g.closedAt).slice(0, 16).replace('T', ' ')} UTC)`);
    dropped++;
    return false;
  });
  return dropped;
}

load();
// Boot is the one moment a long-lived process is guaranteed to re-read the
// clock, so an install that sits untouched for a month still tidies itself.
// Every write prunes dates too (see create/update), the same way today.js does.
if (pruneDates() + pruneClosed()) persist();

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

// ── Jobs close when they ship ────────────────────────────────────────────────
// A group matches stock by ITEM CODE and nothing else — not a pallet, not a
// serial, not a receipt date. Left alone that means the NEXT arrival of the
// same code silently rejoins a group whose work already shipped — scan a job
// out, receive the item back, and the finished job is back in front of the
// floor as though nothing happened. That rejoin was the single most confusing
// thing groups did, so closing is now the DEFAULT, not an opt-in:
//
//   default   — a JOB. It closes itself once its stock ships, and stock that
//               comes back does NOT rejoin it — it reads as unassigned until a
//               manager puts it in a group on purpose.
//   `family`  — the opt-in for a real product family ("Grassfed beef" should
//               pick up the next delivery). It never closes itself.
//
// The same rule then runs ONE CODE AT A TIME inside a job that is still open.
// A group of four codes whose first code ships is not finished — but that code
// is, and left alone it rejoins silently the moment the next pallet of it is
// received: the same confusion as the group-level rejoin, just too small to
// close the group. So a job RELEASES a code as soon as that code's stock ships.
// The group carries on with what's left, the released code stops matching, and
// stock of it that comes back reads under "Not in a group" until a manager
// gives it a job on purpose. Releasing the LAST code leaves the job with
// nothing on hand, which is exactly when it closes — so a one-code job behaves
// precisely as it always did.
//
// Two bits of state drive the closing:
//   seenStock — armed. A job created before its pallets land must not close
//               on the spot merely for never having had any.
//   closedAt  — shipped. Once armed and then empty, the job is over: it stops
//               matching stock and drops off the board, until someone reopens
//               it by hand. Nothing reopens itself, because "the code came back"
//               is exactly the event this exists to ignore.
//   closedBy  — only set by a MANUAL close (see close()), so the editor can say
//               who ended the job instead of claiming its stock shipped.
//   seenItems — armed, per code. Same guard as seenStock one level down: a code
//               that has never been on hand cannot have shipped.
//   left      — { code: when }. Released. Nothing releases itself back: a
//               manager puts one code back with restore(), or reopens the job,
//               which re-arms the whole of it.
//
// A job can also go stale WITHOUT ever arming: its stock shipped before the
// app was watching (the pre-close-rule world), or never arrived at all. Left
// open, it lies in wait — the next delivery of its codes, weeks later, lands
// inside a forgotten group with dead dates, which is the original rejoin
// confusion wearing a new hat. So an open job with nothing on hand, nothing
// scheduled today or later, no standing note, and no edit in STALE_DAYS also
// closes. Anything that still means future work — a dated note from today on,
// or a standing note — protects the group no matter how old it is.
const STALE_DAYS = 7;

// The codes a group actually CLAIMS right now: what it is made of, minus the
// work it has already finished. A group's definition (`items`) and what it
// matches stopped being the same list the moment jobs started closing, and the
// per-code release below splits them further — so everything that folds stock
// into a group reads THIS, never `items`: the dashboard's group rows, the
// "Not in a group" tab, and the onHand flag the Today board prints.
function claims(g) {
  if (!g) return [];
  if (g.closedAt) return []; // the whole job is over — it claims nothing at all
  if (!g.left || g.family) return g.items;
  return g.items.filter((c) => !g.left[c]);
}

// ── Split batches ────────────────────────────────────────────────────────────
// A group matches by item code, which is the right unit for "watch this
// product" and the wrong one for "this lot goes back Wednesday". One code's
// stock arrives in batches — pallets that went into temper on the 1st are ready
// before the ones from the 2nd, and they are two jobs however much they share
// an item number.
//
// So a group can be PINNED to a list of pallet ids: a batch job, holding
// exactly those pallets and nothing else. split() makes one out of part of an
// existing group. The parent keeps claiming the codes, so the next delivery
// joins it as before — a recurring job stays recurring, and only the batch that
// was split off is frozen.
//
// The two must not both count the same pallet, so a pinned pallet belongs to
// its batch and drops out of any unpinned group that claims the same code.
// Keyed by pallet AND item, because one physical pallet can carry two products
// and only one of them may be the batch's.
const pinKey = (pallet, item) => `${pallet}|${item}`;
const isBatch = (g) => !!(g && Array.isArray(g.pallets) && g.pallets.length);

// Every (pallet, item) an OPEN batch has claimed. What unpinned groups subtract.
function pinnedRows(list) {
  const s = new Set();
  for (const g of (list || groups)) {
    if (g.closedAt || !isBatch(g)) continue;
    for (const p of g.pallets) for (const i of g.items) s.add(pinKey(p, i));
  }
  return s;
}

// Does this group claim this pallet line? The one rule, so the server's
// aggregation, the board's onHand flag and the dashboard's fold cannot drift.
function claimsRow(g, item, pallet, pinned) {
  if (!g || g.closedAt) return false;
  if (isBatch(g)) return g.items.includes(item) && g.pallets.includes(pallet);
  if (!claims(g).includes(item)) return false;
  return !pinned || !pinned.has(pinKey(pallet, item));
}

const cleanPallets = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
  .map((x) => String(x || '').trim()).filter(Boolean))].slice(0, MAX_PALLETS);

// Split a batch off a group: a NEW group holding exactly these pallets, while
// the parent carries on claiming its codes (minus these pallets, which are now
// somebody else's). Deliberately carries no notes or dates over — a batch is a
// job with its own schedule, and inheriting the parent's dated work would put
// the same instruction on the board twice.
function split(id, fields, who) {
  const parent = get(id);
  if (!parent) return null;
  const f = fields || {};
  if (parent.closedAt) return { error: 'That job is closed — reopen it before splitting it' };
  const pallets = cleanPallets(f.pallets);
  if (!pallets.length) return { error: 'Pick at least one pallet to split off' };
  const items = cleanItems(f.items && f.items.length ? f.items : parent.items)
    .filter((c) => parent.items.includes(c));
  if (!items.length) return { error: 'Those pallets carry nothing this group claims' };
  const name = cleanName(f.name) || `${parent.name} — batch`;
  if (nameTaken(name, null)) return { error: `A group called '${name}' already exists` };
  // Its own pallets don't count as taken — splitting a batch again (two temper
  // dates inside one lot) is a legitimate thing to want.
  const already = pinnedRows(groups.filter((x) => x.id !== parent.id));
  const taken = pallets.filter((p) => items.some((i) => already.has(pinKey(p, i))));
  if (taken.length) return { error: `Already split off: ${taken.slice(0, 3).join(', ')}` };
  if (isBatch(parent)) {
    // Splitting a batch MOVES pallets out of it, rather than leaving both
    // holding the same ones. Taking all of them would silently promote the
    // parent back to claiming its codes outright, which is not a split.
    const rest = parent.pallets.filter((p) => !pallets.includes(p));
    if (!rest.length) return { error: 'That would leave the original with nothing — rename it instead' };
    parent.pallets = rest;
    parent.updatedBy = who || null;
    parent.updatedAt = new Date().toISOString();
  }
  const rec = { id: groups.reduce((m, g) => Math.max(m, g.id), 0) + 1,
    name, items, pallets, plan: {}, dates: {},
    updatedBy: who || null, updatedAt: new Date().toISOString() };
  groups.push(rec);
  persist();
  return rec;
}

// Is any of this group's own stock on hand? `stock` is inventory's per-item
// index (item -> { pallets:Set, … }). A BATCH answers for its own pallets; an
// ordinary group answers for its codes, deliberately WITHOUT subtracting the
// pallets it has split off — its stock is still in the building, just assigned
// to a batch, and a parent that closed the moment it was split would stop
// taking the next delivery, which is the opposite of what splitting is for.
function onHandNow(g, stock) {
  if (!g || g.closedAt || !stock) return false;
  if (isBatch(g)) {
    for (const p of g.pallets) {
      for (const i of g.items) {
        const s = stock.get(i);
        if (s && s.pallets.has(p)) return true;
      }
    }
    return false;
  }
  return claims(g).some((c) => stock.has(c));
}

function reconcile(stock) {
  // Aging out closed jobs rides the same clock tick: reconcile runs on every
  // read path, which is what keeps "7 days" meaning 7 days rather than
  // "whenever the process next restarts".
  let changed = pruneClosed() > 0;
  const today = cutoff(0);
  const staleCut = cutoff(STALE_DAYS);
  const isStale = (g) => !g.note
    && !Object.keys(g.dates || {}).some((d) => d >= today)
    && String(g.updatedAt || '').slice(0, 10) < staleCut;
  for (const g of groups) {
    if (g.family || g.closedAt) continue;
    // A BATCH is pinned to pallets, so it arms and closes on those and nothing
    // else. Releasing a code from it would mean nothing — the batch IS the
    // unit, and when its pallets ship the job is over.
    if (isBatch(g)) {
      const onBatch = onHandNow(g, stock);
      if (onBatch && !g.seenStock) {
        g.seenStock = true;
        changed = true;
        console.log(`[Groups] batch '${g.name}' armed — ${g.pallets.length} pallet(s) on hand`);
      } else if (!onBatch && g.seenStock) {
        g.closedAt = new Date().toISOString();
        changed = true;
        console.log(`[Groups] batch '${g.name}' closed itself — its pallets have shipped`);
      } else if (!onBatch && isStale(g)) {
        g.closedAt = new Date().toISOString();
        changed = true;
        console.log(`[Groups] batch '${g.name}' closed itself — nothing on hand, nothing scheduled, untouched for ${STALE_DAYS}+ days`);
      }
      continue;
    }
    // Per CODE first: arm the ones that turn up, release the ones that go. A
    // code is only ever released once it has actually BEEN here — otherwise a
    // job written the day before its pallets land would shed its whole item
    // list on the first tick, which is the trap seenStock exists to avoid one
    // level up.
    const wasArmed = !!g.seenStock;
    const seen = new Set(g.seenItems || []);
    const left = g.left || {};
    let on = false;
    let perItem = false;
    for (const c of g.items) {
      if (left[c]) continue; // released — the next pallet of it is somebody else's job
      if (stock.has(c)) {
        on = true;
        if (!seen.has(c)) {
          seen.add(c);
          perItem = true;
          // Only worth a line once the job is already running: the first codes
          // to land are covered by the group's own "armed" message below.
          if (wasArmed) console.log(`[Groups] job '${g.name}': ${c} joined it — its stock is on hand`);
        }
      } else if (seen.has(c)) {
        left[c] = new Date().toISOString();
        seen.delete(c);
        perItem = true;
        console.log(`[Groups] job '${g.name}': ${c} shipped — released from the job; stock of it that comes back will not rejoin`);
      }
    }
    if (perItem) {
      if (seen.size) g.seenItems = [...seen]; else delete g.seenItems;
      if (Object.keys(left).length) g.left = left; else delete g.left;
      changed = true;
    }
    // Every transition is logged: "when did the app decide this" has to be
    // answerable from the server log, not reconstructed from memory — the
    // close is automatic and the floor will ask.
    if (on && !g.seenStock) {
      g.seenStock = true;
      changed = true;
      console.log(`[Groups] job '${g.name}' armed — its stock is on hand`);
    } else if (!on && g.seenStock) {
      g.closedAt = new Date().toISOString();
      changed = true;
      console.log(`[Groups] job '${g.name}' closed itself — the snapshot shows no stock left of ${g.items.join('/')}`);
    } else if (!on && isStale(g)) {
      g.closedAt = new Date().toISOString();
      changed = true;
      console.log(`[Groups] job '${g.name}' closed itself — nothing on hand, nothing scheduled, untouched for ${STALE_DAYS}+ days`);
    }
  }
  if (changed) persist();
  return changed;
}

// Forget the per-code job state for whichever codes the predicate picks out,
// tidying both fields away entirely once they are empty — absent rather than
// `{}`, so `g.left` alone still answers "has this job released anything".
function forgetItems(g, drop) {
  if (g.seenItems) {
    g.seenItems = g.seenItems.filter((c) => !drop(c));
    if (!g.seenItems.length) delete g.seenItems;
  }
  if (g.left) {
    for (const c of Object.keys(g.left)) if (drop(c)) delete g.left[c];
    if (!Object.keys(g.left).length) delete g.left;
  }
}

// Put ONE released code back to work without disturbing the rest of the job —
// "that one came back, and it IS still part of this". It has to be seen on hand
// again before it can be released a second time, so putting back a code whose
// stock is still out doesn't simply release it again on the next snapshot.
function restore(id, code, who) {
  const g = get(id);
  if (!g) return null;
  code = String(code || '').trim();
  if (g.closedAt) return { error: 'That job is closed — reopen it to put its products back to work' };
  if (!g.items.includes(code)) return { error: 'That product is not in this group' };
  if (!g.left || !g.left[code]) return { error: 'That product has not left this group' };
  forgetItems(g, (c) => c === code);
  g.updatedBy = who || null;
  g.updatedAt = new Date().toISOString();
  persist();
  return g;
}

// End a job NOW instead of waiting for the snapshot to read it empty — the
// answer to "its stock came back and is sitting under a finished job". Unlike
// reconcile()'s close the stock may well still be on hand, so it records who
// did it rather than letting the editor claim the stock shipped.
function close(id, who) {
  const g = get(id);
  if (!g) return null;
  if (g.closedAt) return { error: 'That job is already closed' };
  g.closedAt = new Date().toISOString();
  g.closedBy = who || null;
  g.updatedBy = who || null;
  g.updatedAt = g.closedAt;
  persist();
  return g;
}

// Put a closed job back to work — and re-arm it, so it has to see its stock
// again before it can close a second time.
function reopen(id, who) {
  const g = get(id);
  if (!g) return null;
  if (!g.closedAt) return { error: 'That job is not closed' };
  delete g.closedAt;
  delete g.closedBy;
  delete g.seenStock;
  // The whole job goes back to work, released codes included: "reopen" means
  // this job is not over after all, and half a job is not what anyone pressed.
  delete g.seenItems;
  delete g.left;
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
// six of them now, and `create(name, items, plan, dates, note, family, who)` is
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
  if (f.family) rec.family = true;
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
    // A code taken off the group takes its per-code job state with it, so
    // picking it again later starts clean instead of inheriting a release from
    // a previous life. (Untick, save, retick is the long way round to
    // restore(); it still has to land somewhere sane.)
    forgetItems(g, (c) => !items.includes(c));
  }
  // An all-blank plan/dates is a legitimate edit — a manager clearing it — so
  // these replace rather than merge. Omitting a field entirely leaves it alone.
  // Passing an empty list un-pins a batch back into an ordinary group, which is
  // the only way back from a split short of deleting it.
  if (patch.pallets !== undefined) {
    const pallets = cleanPallets(patch.pallets);
    if (pallets.length) g.pallets = pallets; else delete g.pallets;
  }
  if (patch.plan !== undefined) g.plan = cleanPlan(patch.plan);
  if (patch.dates !== undefined) g.dates = cleanDates(patch.dates);
  if (patch.note !== undefined) {
    const standing = cleanNote(patch.note);
    if (standing) g.note = standing;
    else delete g.note; // clearing the box is how a manager retires a standing job
  }
  // Only a real change of kind resets the job state — the editor sends `family`
  // on every save, and re-saving a closed job to fix its name must not quietly
  // reopen it. A real flip does reset: marking a closed job as a family puts
  // its stock back on the books, and un-marking a family arms it fresh.
  if (patch.family !== undefined && !!patch.family !== !!g.family) {
    if (patch.family) g.family = true;
    else delete g.family;
    delete g.seenStock;
    delete g.seenItems;
    delete g.left;
    delete g.closedAt;
    delete g.closedBy;
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

module.exports = { list, get, claims, claimsRow, pinnedRows, pinKey, isBatch, onHandNow,
  create, update, clearDay, remove, reconcile, close, reopen, restore, split,
  DAYS, KEEP_CLOSED_HOURS };

// areas.js — the rest of the warehouse, for admins, kept APART from the app.
//
// Everything else here is scoped to one location prefix (GT — see inventory.js)
// and that is load-bearing, not cosmetic: a job closes when its item code has
// no stock left in the snapshot, the rack map is GT's 80 bins, and the Today
// board counts GT's free slots. Widen that snapshot and a GT job stays open
// forever because the same code is sitting in JF. So other areas do NOT join
// the snapshot. They live here, in their own read-only store that nothing on
// the board, the groups or the rack ever reads.
//
// Two reads, both made ONLY when an admin is actually looking — there is no
// timer in this file, so an area nobody opens costs Swarmbox nothing:
//
//   survey  — which areas exist and how big each is. One whole-warehouse read
//             of two columns (location, pallet), kept on disk and reused for a
//             day. Swarmbox does the same work for this as for the GT refresh:
//             the location filter only ever cut what was sent back.
//   area    — one area's stock, folded per bin and per product, held in RAM
//             for 15 minutes. Same call the snapshot makes, different prefix.
//
// Never writes to Swarmbox — nothing in this app does.

const fs = require('fs');
const path = require('path');
const { getRows, withRetry } = require('./swarmbox');

const FILE = path.join(__dirname, '..', 'data', 'areas.json');
const SURVEY_TTL_MS = 24 * 60 * 60 * 1000;
const AREA_TTL_MS = 15 * 60 * 1000; // the snapshot's own rhythm (inventory.js)
// A manual rescan is a whole-warehouse read, so it is rationed for everyone
// together — the cost lands on Swarmbox, which does not care who asked.
const RESCAN_MIN_MS = 10 * 60 * 1000;
// How many areas stay folded in RAM at once; the oldest is dropped past that.
const KEEP_AREAS = 4;
// An "area" too big to open is not racking. UF is three location codes holding
// ~110k rows — two fifths of the company's inventory in a virtual bulk location
// — and opening it would be a 30MB download to show three lines. Listed, so
// nobody wonders where it went, and refused.
const MAX_ROWS = Number(process.env.AREA_MAX_ROWS) || 60000;
// The app's own area is not "another area": it has the feed and the dashboard.
const HOME = String(process.env.LOCATION_PREFIX || 'GT').trim().toUpperCase();

// Same columns the snapshot takes, minus the ones this view never shows — and,
// like the snapshot, never the cost.
const SELECT = ['item', 'description', 'pallet', 'base_quantity', 'base_uom',
  'variable_quantity', 'variable_uom', 'state', 'date', 'state_date', 'location'].join(',');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const up = (v) => String(v == null ? '' : v).trim().toUpperCase();
// A location's area is everything before its first dot: GT.2.Z3.D04 -> GT.
const areaOf = (loc) => { const i = loc.indexOf('.'); return up(i < 0 ? loc : loc.slice(0, i)); };
const PREFIX_OK = /^[A-Z0-9]{1,6}$/;

// ── Survey ───────────────────────────────────────────────────────────────────
let survey = null;   // { at: ISO, areas: [{ prefix, bins, pallets, rows }] }
let surveying = null; // the read in flight, shared by everyone waiting on it
let lastRescan = 0;

try {
  const o = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (o && Array.isArray(o.areas) && o.at) survey = o;
} catch (e) {
  if (e.code !== 'ENOENT') console.error('[Areas] survey cache ignored:', e.message);
}

async function runSurvey() {
  const started = Date.now();
  const res = await withRetry(
    () => getRows(`rpc/inventory_detail?p_item=${encodeURIComponent('%')}&select=location,pallet`, { background: true }),
    { attempts: 2, baseMs: 1000, label: 'area survey' });
  if (!res.ok) throw new Error(`Swarmbox did not answer (${res.status || 'err'})`);
  const m = new Map();
  for (const r of res.data) {
    const loc = String(r.location || '').trim();
    if (!loc) continue;
    const p = areaOf(loc);
    let a = m.get(p);
    if (!a) { a = { rows: 0, bins: new Set(), pallets: new Set() }; m.set(p, a); }
    a.rows++;
    a.bins.add(loc);
    if (r.pallet) a.pallets.add(r.pallet);
  }
  survey = { at: new Date().toISOString(),
    areas: [...m].map(([prefix, a]) => ({ prefix, bins: a.bins.size, pallets: a.pallets.size, rows: a.rows }))
      .sort((x, y) => y.bins - x.bins || x.prefix.localeCompare(y.prefix)) };
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(survey, null, 2));
  } catch (e) {
    console.error('[Areas] survey save failed:', e.message);
  }
  console.log(`[Areas] surveyed ${res.data.length} rows / ${survey.areas.length} areas in ${Math.round((Date.now() - started) / 1000)}s`);
  return survey;
}

// One read however many people are waiting on it.
function surveyOnce() {
  if (!surveying) surveying = runSurvey().finally(() => { surveying = null; });
  return surveying;
}

const describe = (s) => ({
  surveyedAt: s.at,
  home: HOME,
  areas: s.areas.filter((a) => a.prefix !== HOME).map((a) => ({ ...a,
    ...(a.rows > MAX_ROWS ? { blocked: 'A bulk location, not racking — too large to open here.' } : {}) })),
});

// The directory. Reads Swarmbox only when there is no survey yet or the one on
// file is more than a day old; a failed re-read falls back to the old list,
// which is still a better answer than an error.
async function list() {
  if (survey && Date.now() - Date.parse(survey.at) < SURVEY_TTL_MS) return describe(survey);
  try {
    return describe(await surveyOnce());
  } catch (e) {
    if (survey) return { ...describe(survey), stale: e.message };
    throw e;
  }
}

async function rescan() {
  const since = Date.now() - lastRescan;
  if (since < RESCAN_MIN_MS) {
    return { error: `Rescanned a moment ago — try again in ${Math.ceil((RESCAN_MIN_MS - since) / 60000)} min` };
  }
  lastRescan = Date.now();
  return describe(await surveyOnce());
}

// ── One area ─────────────────────────────────────────────────────────────────
const cache = new Map();   // prefix -> { at: ms, data }
const loading = new Map(); // prefix -> the read in flight

// Fold raw rows down to what the page draws: each bin, and inside it each
// product with its pallets, quantity and age. The raw rows are dropped as soon
// as this returns — JF is 37k of them, and nothing here needs one twice.
function fold(prefix, rows) {
  const bins = new Map();
  const pallets = new Set();
  let kept = 0;
  for (const r of rows) {
    const loc = String(r.location || '').trim();
    // `like.F.*` already excludes F1 and F2; this is the same belt-and-braces
    // check the snapshot makes against its own server-side filter.
    if (!loc || areaOf(loc) !== prefix) continue;
    kept++;
    let b = bins.get(loc);
    if (!b) { b = { pallets: new Set(), items: new Map() }; bins.set(loc, b); }
    const item = String(r.item || '').trim();
    let it = b.items.get(item);
    if (!it) {
      it = { item, description: r.description ? String(r.description) : '', pallets: new Set(),
        units: 0, qty: new Map(), states: new Set(), since: null, received: null };
      b.items.set(item, it);
    }
    it.units++;
    if (r.pallet) { it.pallets.add(String(r.pallet)); b.pallets.add(String(r.pallet)); pallets.add(String(r.pallet)); }
    const uom = up(r.base_uom);
    if (uom) it.qty.set(uom, (it.qty.get(uom) || 0) + num(r.base_quantity));
    if (r.state) it.states.add(up(r.state));
    // The OLDEST of each date: "how long has the first of it been sitting".
    if (r.state_date && (!it.since || r.state_date < it.since)) it.since = r.state_date;
    if (r.date && (!it.received || r.date < it.received)) it.received = r.date;
  }
  const locations = [...bins].map(([code, b]) => ({
    code,
    pallets: b.pallets.size,
    items: [...b.items.values()].map((it) => ({
      item: it.item, description: it.description, pallets: it.pallets.size, units: it.units,
      qty: [...it.qty].map(([uom, qty]) => ({ uom, qty })),
      states: [...it.states], since: it.since, received: it.received,
    })).sort((x, y) => x.item.localeCompare(y.item)),
  })).sort((x, y) => x.code.localeCompare(y.code));
  return { prefix, builtAt: new Date().toISOString(), rows: kept, pallets: pallets.size, locations };
}

async function load(prefix) {
  const started = Date.now();
  const q = `rpc/inventory_detail?p_item=${encodeURIComponent('%')}`
    + `&location=like.${encodeURIComponent(prefix + '.*')}&select=${SELECT}`;
  const res = await withRetry(() => getRows(q, { background: true }),
    { attempts: 2, baseMs: 1000, label: `area ${prefix}` });
  if (!res.ok) throw new Error(`Swarmbox did not answer (${res.status || 'err'})`);
  const data = fold(prefix, res.data);
  cache.set(prefix, { at: Date.now(), data });
  while (cache.size > KEEP_AREAS) cache.delete(cache.keys().next().value);
  console.log(`[Areas] ${prefix}: ${data.rows} rows / ${data.locations.length} bins in ${Math.round((Date.now() - started) / 1000)}s`);
  return data;
}

// `fresh` skips the 15-minute copy — the page's own Refresh button.
async function get(prefix, fresh) {
  prefix = up(prefix);
  if (!PREFIX_OK.test(prefix)) return { error: 'Not an area' };
  if (prefix === HOME) return { error: `${HOME} is the app's own area — use the feed and the dashboard` };
  // Only areas the survey knows: the prefix goes into a Swarmbox query, and the
  // size check below needs a row count to check against.
  const known = (await list()).areas.find((a) => a.prefix === prefix);
  if (!known) return { error: 'No such area' };
  if (known.blocked) return { error: known.blocked };
  const hit = cache.get(prefix);
  // Even a forced refresh reuses a copy under 30 seconds old, so leaning on the
  // button can't turn into a stream of reads (same floor as /api/refresh).
  if (hit && Date.now() - hit.at < (fresh ? 30000 : AREA_TTL_MS)) return hit.data;
  if (!loading.has(prefix)) loading.set(prefix, load(prefix).finally(() => loading.delete(prefix)));
  return loading.get(prefix);
}

module.exports = { list, rescan, get };

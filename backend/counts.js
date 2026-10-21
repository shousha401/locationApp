// counts.js — cycle-count sheets, one row of racking at a time.
//
// The team counts overstock row by row (Cooler 1 F row, Freezer 1 K row …) off
// a sheet that lists every bin, product and pallet with the quantity Swarmbox
// thinks is there. Those sheets were built by hand in Excel; this builds the
// same list straight from Swarmbox, so the bins, pallet ids and system
// quantities are the ones on the racks right now and nobody retypes a header.
//
// Kept apart from everything else exactly like areas.js, and for the same
// reason: nothing here may touch the GT snapshot, a group, the board or the
// rack map. It only reads. It never writes to Swarmbox, and it keeps no
// counts of its own yet — the sheet is printed or downloaded and counted on
// paper the way it is today.
//
// One read per area, made only when an editor or admin opens that area here,
// and kept for 15 minutes so walking from row to row costs nothing.

const { getRows, withRetry } = require('./swarmbox');
const areas = require('./areas');
const inventory = require('./inventory');

const TTL_MS = 15 * 60 * 1000; // the snapshot's own rhythm (inventory.js)
const FRESH_FLOOR_MS = 30000;  // even a forced re-read reuses a copy this young
const KEEP_AREAS = 3;
const HOME = String(process.env.LOCATION_PREFIX || 'GT').trim().toUpperCase();
const PREFIX_OK = /^[A-Z0-9]{1,6}$/;
const OTHER = '~other';

// What a count sheet needs and nothing more — never the cost.
const SELECT = ['item', 'description', 'pallet', 'base_quantity', 'base_uom', 'location'].join(',');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const up = (v) => String(v == null ? '' : v).trim().toUpperCase();
const areaOf = (loc) => { const i = loc.indexOf('.'); return up(i < 0 ? loc : loc.slice(0, i)); };

// The names the floor uses on its own sheets. An area not listed here is
// named by its code.
const KIND = { JC: 'Cooler', JF: 'Freezer', JP: 'Produce' };

// Where a bin sits, read from its code the same way the Areas rack view reads
// it (parseBin in areas.html), so a row here is the row that page draws:
// JC.1.F01.E03 is row 1-F, bay 01, level E, spot 03. A code that is not
// racking (JC.3.E.VAL, a dock, a floor spot) goes on the "Floor & other" sheet.
function placeOf(code) {
  const s = code.split('.');
  if (s.length !== 4) return null;
  const lv = /^([A-Z])(\d{1,3})$/.exec(up(s[3]));
  if (!lv) return null;
  const m = /^([A-Z])(\d{1,3})$/.exec(up(s[2]));
  if (m) return { row: `${up(s[1])}-${m[1]}`, zone: up(s[1]), letter: m[1], bay: m[2], level: lv[1], spot: Number(lv[2]) };
  if (/^\d{1,3}$/.test(s[2])) return { row: up(s[1]), zone: '', letter: up(s[1]), bay: s[2], level: lv[1], spot: Number(lv[2]) };
  return null;
}

function rowLabel(prefix, p) {
  if (!p) return 'Floor & other';
  const kind = KIND[prefix] || prefix;
  return p.zone ? `${kind} ${p.zone} · ${p.letter} row` : `${kind} · ${p.letter} row`;
}

const nat = (x, y) => String(x).localeCompare(String(y), undefined, { numeric: true });

// Fold raw rows into rows of racking, and each row into one line per bin,
// product and pallet: the line a counter ticks off. The system quantity is the
// cases (base quantity) Swarmbox holds for that pallet in that bin.
function fold(prefix, raw) {
  const rows = new Map();
  for (const r of raw) {
    const loc = String(r.location || '').trim();
    if (!loc || areaOf(loc) !== prefix) continue;
    const p = placeOf(loc);
    const key = p ? p.row : OTHER;
    let row = rows.get(key);
    if (!row) { row = { key, label: rowLabel(prefix, p), lines: new Map(), bins: new Set(), pallets: new Set() }; rows.set(key, row); }
    const item = String(r.item || '').trim();
    const pallet = r.pallet ? String(r.pallet).trim() : '';
    const lk = `${loc}|${item}|${pallet}`;
    let li = row.lines.get(lk);
    if (!li) {
      li = { location: loc, item, description: r.description ? String(r.description) : '', pallet, qty: new Map(),
        sort: p ? [p.bay, p.spot, p.level] : [loc, 0, ''] };
      row.lines.set(lk, li);
    }
    const uom = up(r.base_uom) || 'CS';
    li.qty.set(uom, (li.qty.get(uom) || 0) + num(r.base_quantity));
    row.bins.add(loc);
    if (pallet) row.pallets.add(pallet);
  }
  const out = [...rows.values()].map((row) => ({
    key: row.key,
    label: row.label,
    bins: row.bins.size,
    pallets: row.pallets.size,
    // Walking order: down the row bay by bay, spot by spot, every level of a
    // spot together — the order the old sheets were in.
    lines: [...row.lines.values()].sort((a, b) => nat(a.sort[0], b.sort[0]) || a.sort[1] - b.sort[1]
      || a.sort[2].localeCompare(b.sort[2]) || nat(a.item, b.item) || a.pallet.localeCompare(b.pallet))
      .map(({ sort, qty, ...li }) => ({ ...li, qty: [...qty].map(([uom, q]) => ({ uom, qty: q })) })),
  })).sort((a, b) => (a.key === OTHER) - (b.key === OTHER) || nat(a.key, b.key));
  return out;
}

const cache = new Map();   // prefix -> { at: ms, data }
const loading = new Map(); // prefix -> the read in flight

async function load(prefix) {
  const started = Date.now();
  let raw;
  let builtAt;
  if (prefix === HOME) {
    // The home area is already in memory: the snapshot every other page uses.
    const h = inventory.homeRows();
    if (!h.ok) throw new Error('the inventory is still loading — try again in a minute');
    raw = h.rows;
    builtAt = new Date(h.builtAt).toISOString();
  } else {
    const q = `rpc/inventory_detail?p_item=${encodeURIComponent('%')}`
      + `&location=like.${encodeURIComponent(prefix + '.*')}&select=${SELECT}`;
    const res = await withRetry(() => getRows(q, { background: true }),
      { attempts: 2, baseMs: 1000, label: `count sheets ${prefix}` });
    if (!res.ok) throw new Error(`Swarmbox did not answer (${res.status || 'err'})`);
    raw = res.data;
    builtAt = new Date().toISOString();
  }
  const rows = fold(prefix, raw);
  const data = { prefix, kind: KIND[prefix] || null, builtAt, rows };
  cache.set(prefix, { at: Date.now(), data });
  while (cache.size > KEEP_AREAS) cache.delete(cache.keys().next().value);
  console.log(`[Counts] ${prefix}: ${rows.length} rows / ${rows.reduce((n, r) => n + r.lines.length, 0)} lines in ${Math.round((Date.now() - started) / 1000)}s`);
  return data;
}

async function area(prefix, fresh) {
  prefix = up(prefix);
  if (!PREFIX_OK.test(prefix)) return { error: 'Not an area' };
  // Only areas the Areas survey knows, and not the bulk ones it refuses: the
  // prefix goes into a Swarmbox query, and UF would be a 30MB read.
  const known = (await areas.list()).areas.find((a) => a.prefix === prefix);
  if (!known) return { error: 'No such area' };
  if (known.blocked) return { error: known.blocked };
  const hit = cache.get(prefix);
  if (hit && Date.now() - hit.at < (fresh ? FRESH_FLOOR_MS : TTL_MS)) return hit.data;
  if (!loading.has(prefix)) loading.set(prefix, load(prefix).finally(() => loading.delete(prefix)));
  return loading.get(prefix);
}

// The area picker: the Areas survey's list, minus the bulk areas it refuses,
// with the areas the floor counts (Cooler, Freezer, Produce) first.
async function list() {
  const dir = await areas.list();
  const order = Object.keys(KIND);
  const rank = (p) => (order.includes(p) ? order.indexOf(p) : order.length);
  return {
    surveyedAt: dir.surveyedAt,
    areas: dir.areas.filter((a) => !a.blocked)
      .map((a) => ({ prefix: a.prefix, kind: KIND[a.prefix] || null, bins: a.bins, slots: a.slots || null }))
      .sort((x, y) => rank(x.prefix) - rank(y.prefix)),
  };
}

// The row picker: every row with its size, no lines.
async function rows(prefix, fresh) {
  const a = await area(prefix, fresh);
  if (a.error) return a;
  return { prefix: a.prefix, kind: a.kind, builtAt: a.builtAt,
    rows: a.rows.map(({ lines, ...r }) => ({ ...r, lines: lines.length })) };
}

// One row's sheet.
async function sheet(prefix, key) {
  const a = await area(prefix, false);
  if (a.error) return a;
  const row = a.rows.find((r) => r.key === key);
  if (!row) return { error: 'No such row in this area' };
  return { prefix: a.prefix, kind: a.kind, builtAt: a.builtAt, ...row };
}

module.exports = { list, rows, sheet };

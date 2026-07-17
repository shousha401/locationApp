// inventory.js — the live location feed's engine.
//
// Swarmbox's inventory_detail(p_item) RPC computes the WHOLE inventory server-side
// and then filters, so a per-location query costs the same ~16s as pulling
// everything. That inverts the naive design: instead of one heavy call per watched
// location per refresh, we make ONE call for the entire inventory (~250k rows /
// 6.5k locations), index it by location in RAM, and serve every location instantly
// from that snapshot. Swarmbox sees a single call per refresh cycle no matter how
// many people are watching — which is exactly what its flakiness demands.
//
// A refresh only REPLACES the snapshot on success; a failed pull keeps the last
// good data (with a visible "as of" stamp on the page), so a Swarmbox blip degrades
// to slightly-stale, never blank.

const { getRows, withRetry } = require('./swarmbox');

const REFRESH_MS = Number(process.env.SNAPSHOT_REFRESH_MS) || 5 * 60 * 1000; // 5 min

// Scope the whole app to one location prefix (a manager asked for GT-only). Set
// LOCATION_PREFIX='' to serve every location. The filter is pushed down to Swarmbox
// (location=like.GT*), so we also transfer far less — GT is ~1.7k rows, not 255k.
const PREFIX = String(process.env.LOCATION_PREFIX ?? 'GT').trim().toUpperCase();

// Everything inventory_detail exposes EXCEPT cost — the value is deliberately not
// pulled, so it can't be shown or scraped. 'location' drives the index.
const SELECT = [
  'item', 'description', 'serial', 'pallet',
  'base_quantity', 'base_uom', 'variable_quantity', 'variable_uom',
  'lean_point', 'state', 'date', 'state_date',
  'purchase_order', 'manufacturer', 'barcode', 'location',
].join(',');
const LOC_FILTER = PREFIX ? `&location=like.${encodeURIComponent(PREFIX + '*')}` : '';
const QUERY = `rpc/inventory_detail?p_item=${encodeURIComponent('%')}${LOC_FILTER}&select=${SELECT}`;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const up = (v) => { const s = String(v == null ? '' : v).trim().toUpperCase(); return s || null; };

let snap = {
  builtAt: null,          // Date of last SUCCESSFUL pull
  ok: false,
  building: false,
  lastError: null,
  rowCount: 0,
  byLocation: new Map(),  // location code -> [ light rows ]
  locations: [],          // sorted distinct codes (for typeahead)
  itemDesc: new Map(),     // item code -> description (deduped; saves memory)
};

async function pull() {
  // background lane: nobody is blocked on it, and it's a heavy call — keep a
  // foreground slot free for interactive reads (there aren't any today, but the
  // guardrail costs nothing and future-proofs it).
  return withRetry(() => getRows(QUERY, { background: true }),
    { attempts: 3, baseMs: 1000, label: 'inventory snapshot' });
}

// Turn raw rows into the by-location index, deduping descriptions out of the rows
// (255k rows repeating a few thousand descriptions is a lot of wasted memory).
function build(rows) {
  const byLocation = new Map();
  const itemDesc = new Map();
  for (const r of rows) {
    const loc = String(r.location || '').trim();
    if (!loc) continue;
    if (PREFIX && !loc.toUpperCase().startsWith(PREFIX)) continue; // belt-and-suspenders vs the server-side filter
    const item = String(r.item || '').trim();
    if (item && r.description && !itemDesc.has(item)) itemDesc.set(item, String(r.description));
    let arr = byLocation.get(loc);
    if (!arr) { arr = []; byLocation.set(loc, arr); }
    arr.push({
      item,
      serial: r.serial ? String(r.serial) : null,
      pallet: r.pallet ? String(r.pallet) : null,
      baseQty: num(r.base_quantity), baseUom: up(r.base_uom),
      varQty: num(r.variable_quantity), varUom: up(r.variable_uom),
      lean: (r.lean_point == null || r.lean_point === '') ? null : num(r.lean_point),
      state: up(r.state), date: r.date || null, stateDate: r.state_date || null,
      po: r.purchase_order ? String(r.purchase_order) : null,
      manufacturer: r.manufacturer ? String(r.manufacturer) : null,
      barcode: r.barcode ? String(r.barcode) : null,
    });
  }
  return { byLocation, itemDesc, locations: [...byLocation.keys()].sort(), rowCount: rows.length };
}

// Pull + swap. Never throws; on failure keeps the previous snapshot.
async function refresh() {
  if (snap.building) return snap;
  snap.building = true;
  const started = Date.now();
  try {
    const res = await pull();
    if (res.ok) {
      const b = build(res.data);
      snap = {
        builtAt: new Date(), ok: true, building: false, lastError: null,
        rowCount: b.rowCount, byLocation: b.byLocation, locations: b.locations, itemDesc: b.itemDesc,
      };
      console.log(`[Inventory] snapshot refreshed: ${b.rowCount} rows / ${b.locations.length} locations in ${Math.round((Date.now() - started) / 1000)}s`);
    } else {
      snap.building = false;
      snap.lastError = `(${res.status || 'err'}) ${(res.text || '').slice(0, 120)}`;
      console.error('[Inventory] snapshot refresh FAILED:', snap.lastError, '— keeping last good snapshot');
    }
  } catch (e) {
    snap.building = false;
    snap.lastError = String((e && e.message) || e);
    console.error('[Inventory] refresh threw:', snap.lastError);
  }
  return snap;
}

function status() {
  return {
    ok: snap.ok,
    building: snap.building,
    builtAt: snap.builtAt,
    rowCount: snap.rowCount,
    locationCount: snap.locations.length,
    lastError: snap.lastError,
    refreshMs: REFRESH_MS,
    prefix: PREFIX,
  };
}

// Typeahead: prefix matches first, then substring, capped.
function searchLocations(q, limit = 50) {
  q = String(q || '').trim().toUpperCase();
  if (!q) return snap.locations.slice(0, limit);
  const starts = [];
  const contains = [];
  for (const l of snap.locations) {
    const u = l.toUpperCase();
    if (u.startsWith(q)) starts.push(l);
    else if (u.includes(q)) contains.push(l);
  }
  return starts.concat(contains).slice(0, limit);
}

// The full contents of one location — every pallet/unit as its own row, with all
// the detail Swarmbox carries (product code, pallet id, serial, pack, weight, lean,
// state, received date, PO, manufacturer, barcode). GT bins are small (≤~100 rows)
// so we return them whole; no grouping, and deliberately no value.
function getLocation(code) {
  code = String(code || '').trim();
  let rows = snap.byLocation.get(code);
  if (!rows) {
    const hit = snap.locations.find((l) => l.toUpperCase() === code.toUpperCase());
    if (hit) { code = hit; rows = snap.byLocation.get(hit); }
  }
  if (!rows) {
    return { code, found: false, builtAt: snap.builtAt, rows: [], lineCount: 0, products: 0, pallets: 0, weight: [] };
  }

  const products = new Set();
  const pallets = new Set();
  const weight = new Map(); // uom -> summed variable_quantity
  for (const r of rows) {
    products.add(r.item);
    if (r.pallet) pallets.add(r.pallet);
    if (r.varUom) weight.set(r.varUom, (weight.get(r.varUom) || 0) + r.varQty);
  }

  const detail = rows.map((r) => ({
    item: r.item, description: snap.itemDesc.get(r.item) || '',
    pallet: r.pallet, serial: r.serial,
    baseQty: r.baseQty, baseUom: r.baseUom,
    varQty: r.varQty, varUom: r.varUom,
    lean: r.lean, state: r.state, date: r.date, stateDate: r.stateDate,
    po: r.po, manufacturer: r.manufacturer, barcode: r.barcode,
  })).sort((a, b) => (
    a.item !== b.item ? (a.item < b.item ? -1 : 1)
      : (String(a.pallet || '') < String(b.pallet || '') ? -1 : 1)
  ));

  return {
    code, found: true, builtAt: snap.builtAt,
    lineCount: rows.length, products: products.size, pallets: pallets.size,
    weight: [...weight.entries()].map(([uom, qty]) => ({ uom, qty })),
    rows: detail,
  };
}

let timer = null;
function start() {
  refresh(); // warm on boot
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, refresh, status, searchLocations, getLocation };

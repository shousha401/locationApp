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

// 15 min default: pallets sit for hours-to-days, so refreshing faster just
// re-downloads an identical snapshot — this is the app's ONLY Swarmbox load,
// and being gentle with Swarmbox outranks freshness nobody can perceive.
const REFRESH_MS = Number(process.env.SNAPSHOT_REFRESH_MS) || 15 * 60 * 1000;

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

// Whole-snapshot aggregates for the dashboard: totals, the state mix (the
// tempering pipeline), oldest pallets, biggest products, and a one-line summary
// per location. Pure RAM reads over ~1.7k rows — cheap enough to recompute per
// request, and zero extra Swarmbox load.
function overview() {
  const addW = (map, uom, qty) => { if (uom) map.set(uom, (map.get(uom) || 0) + qty); };
  const wArr = (map) => [...map.entries()].map(([uom, qty]) => ({ uom, qty }));

  const totalsW = new Map();
  const allPallets = new Set();
  const allProducts = new Set();
  let units = 0;

  const states = new Map();   // state -> { units, pallets:Set, weight:Map }
  const products = new Map(); // item  -> { item, description, units, pallets:Set, weight:Map }
  const pallets = new Map();  // pallet|item -> { pallet, item, location, date, state, stateDate, units, weight:Map }
  const locations = [];

  for (const [code, rows] of snap.byLocation) {
    const loc = { code, products: new Set(), pallets: new Set(), units: rows.length,
      weight: new Map(), states: new Set(), oldest: null };
    for (const r of rows) {
      units++;
      allProducts.add(r.item); loc.products.add(r.item);
      if (r.pallet) { allPallets.add(r.pallet); loc.pallets.add(r.pallet); }
      addW(totalsW, r.varUom, r.varQty); addW(loc.weight, r.varUom, r.varQty);
      if (r.date && (!loc.oldest || r.date < loc.oldest)) loc.oldest = r.date;

      const st = r.state || 'UNKNOWN';
      loc.states.add(st);
      let s = states.get(st);
      if (!s) { s = { state: st, units: 0, pallets: new Set(), weight: new Map() }; states.set(st, s); }
      s.units++; if (r.pallet) s.pallets.add(r.pallet); addW(s.weight, r.varUom, r.varQty);

      let p = products.get(r.item);
      if (!p) {
        p = { item: r.item, description: snap.itemDesc.get(r.item) || '',
          units: 0, pallets: new Set(), weight: new Map() };
        products.set(r.item, p);
      }
      p.units++; if (r.pallet) p.pallets.add(r.pallet); addW(p.weight, r.varUom, r.varQty);

      const pk = (r.pallet || '~') + '|' + r.item;
      let pa = pallets.get(pk);
      if (!pa) {
        pa = { pallet: r.pallet, item: r.item, description: snap.itemDesc.get(r.item) || '',
          location: code, date: r.date, state: r.state, stateDate: r.stateDate, units: 0, weight: new Map() };
        pallets.set(pk, pa);
      }
      pa.units++; addW(pa.weight, r.varUom, r.varQty);
      if (r.date && (!pa.date || r.date < pa.date)) pa.date = r.date;
    }
    locations.push({
      code, products: loc.products.size, pallets: loc.pallets.size, units: loc.units,
      weight: wArr(loc.weight), states: [...loc.states].sort(), oldest: loc.oldest,
    });
  }
  locations.sort((a, b) => (a.code < b.code ? -1 : 1));

  // "Biggest" ranks by the pallet count first, then the largest single-UOM
  // weight — comparing summed LB+CS+EA totals across items would be meaningless.
  const maxW = (m) => Math.max(0, ...m.weight.values());
  const topProducts = [...products.values()]
    .sort((a, b) => (b.pallets.size - a.pallets.size) || (maxW(b) - maxW(a)))
    .slice(0, 15)
    .map((p) => ({ item: p.item, description: p.description, units: p.units,
      pallets: p.pallets.size, weight: wArr(p.weight) }));

  const oldestPallets = [...pallets.values()]
    .filter((p) => p.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(0, 15)
    .map((p) => ({ ...p, weight: wArr(p.weight) }));

  return {
    ok: snap.ok, builtAt: snap.builtAt, prefix: PREFIX,
    totals: { units, pallets: allPallets.size, products: allProducts.size,
      locations: locations.length, weight: wArr(totalsW) },
    states: [...states.values()]
      .sort((a, b) => b.units - a.units)
      .map((s) => ({ state: s.state, units: s.units, pallets: s.pallets.size, weight: wArr(s.weight) })),
    oldestPallets, topProducts, locations,
  };
}

let timer = null;
function start() {
  refresh(); // warm on boot
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, refresh, status, searchLocations, getLocation, overview };

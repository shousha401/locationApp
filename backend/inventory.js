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

const fs = require('fs');
const path = require('path');
const { getRows, withRetry } = require('./swarmbox');

// 15 min default: pallets sit for hours-to-days, so refreshing faster just
// re-downloads an identical snapshot — this is the app's ONLY Swarmbox load,
// and being gentle with Swarmbox outranks freshness nobody can perceive.
const REFRESH_MS = Number(process.env.SNAPSHOT_REFRESH_MS) || 15 * 60 * 1000;

// Scope the whole app to one location prefix (a manager asked for GT-only). The
// filter is pushed down to Swarmbox (location=like.GT*), so we also transfer far
// less — GT is ~1.7k rows, not 255k. Serving EVERY location is a deliberate,
// heavy choice (~250k rows per refresh cycle), so it requires the explicit token
// LOCATION_PREFIX=* — a blank value falls back to GT, so a dangling
// `LOCATION_PREFIX=` line in .env can't silently switch on the full pull.
const RAW_PREFIX = String(process.env.LOCATION_PREFIX ?? 'GT').trim().toUpperCase();
const PREFIX = (RAW_PREFIX === '*' || RAW_PREFIX === 'ALL') ? '' : (RAW_PREFIX || 'GT');
if (!PREFIX) console.warn('[Inventory] LOCATION_PREFIX=* — serving ALL locations (~250k rows per refresh)');

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
  // 2 attempts, not 3: each attempt can hold a connection up to the full 120s
  // timeout, and a missed cycle only means 15 min of staleness — retrying a
  // third time against an already-struggling Swarmbox isn't worth it.
  return withRetry(() => getRows(QUERY, { background: true }),
    { attempts: 2, baseMs: 1000, label: 'inventory snapshot' });
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

// ── Snapshot cache on disk ───────────────────────────────────────────────────
// The snapshot lived only in RAM, so every restart threw it away: the dashboard
// went blank and Swarmbox took a cold pull on the critical path, just to
// rebuild data that was already correct seconds earlier. Pallets sit for
// hours-to-days, so the last good snapshot is still worth serving.
//
// Mirroring the in-RAM rule: only a SUCCESSFUL pull writes the cache, and boot
// serves the cached snapshot immediately while a fresh pull runs behind it. The
// "as of" stamp carries the ORIGINAL build time, so cached data can never
// masquerade as live.
const CACHE_FILE = path.join(__dirname, '..', 'data', 'snapshot.json');

// Past this age the cache is discarded rather than served: pallet positions
// that old would route someone to the wrong bin, and a blank dashboard is an
// honest failure where confidently-wrong locations are not.
const CACHE_MAX_AGE_MS = Number(process.env.SNAPSHOT_MAX_AGE_MS) || 24 * 60 * 60 * 1000;

// LOCATION_PREFIX=* is ~250k rows (~60MB of JSON) — rewriting that every cycle
// would churn the disk far more than a cold start costs. GT is ~1.7k, so this
// ceiling is only reachable on the deliberate full-inventory setting.
const CACHE_MAX_ROWS = Number(process.env.SNAPSHOT_CACHE_MAX_ROWS) || 50000;

function saveCache(s) {
  if (s.rowCount > CACHE_MAX_ROWS) {
    console.warn(`[Inventory] snapshot cache skipped: ${s.rowCount} rows exceeds SNAPSHOT_CACHE_MAX_ROWS=${CACHE_MAX_ROWS}`);
    return;
  }
  try {
    const payload = {
      v: 1, prefix: PREFIX, builtAt: s.builtAt, rowCount: s.rowCount,
      byLocation: [...s.byLocation], itemDesc: [...s.itemDesc],
    };
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the previous cache intact
    // instead of a truncated file that would poison the next boot.
    const tmp = CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload));
    fs.renameSync(tmp, CACHE_FILE);
  } catch (e) {
    console.error('[Inventory] snapshot cache save failed:', e.message);
  }
}

// Returns a snapshot-shaped object, or null if there's nothing trustworthy to
// serve. Every rejection says why — a silently ignored cache looks identical to
// one that's working.
function loadCache() {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Inventory] snapshot cache unreadable:', e.message);
    return null;
  }
  try {
    if (c.v !== 1 || !Array.isArray(c.byLocation)) {
      console.warn('[Inventory] snapshot cache ignored: unrecognized format'); return null;
    }
    // A cache built under a different LOCATION_PREFIX covers a different slice
    // of the warehouse; serving it would quietly under-report.
    if (String(c.prefix || '') !== PREFIX) {
      console.warn(`[Inventory] snapshot cache ignored: built for prefix "${c.prefix || '*'}", now "${PREFIX || '*'}"`);
      return null;
    }
    const builtAt = new Date(c.builtAt);
    const ageMs = Date.now() - builtAt.getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > CACHE_MAX_AGE_MS) {
      console.warn(`[Inventory] snapshot cache ignored: ${Math.round(ageMs / 3600000)}h old (max ${Math.round(CACHE_MAX_AGE_MS / 3600000)}h)`);
      return null;
    }
    const byLocation = new Map(c.byLocation);
    return {
      builtAt, ok: true, building: false, lastError: null, fromCache: true,
      rowCount: c.rowCount || 0, byLocation, itemDesc: new Map(c.itemDesc || []),
      locations: [...byLocation.keys()].sort(),
    };
  } catch (e) {
    console.error('[Inventory] snapshot cache ignored:', e.message);
    return null;
  }
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
        builtAt: new Date(), ok: true, building: false, lastError: null, fromCache: false,
        rowCount: b.rowCount, byLocation: b.byLocation, locations: b.locations, itemDesc: b.itemDesc,
      };
      console.log(`[Inventory] snapshot refreshed: ${b.rowCount} rows / ${b.locations.length} locations in ${Math.round((Date.now() - started) / 1000)}s`);
      saveCache(snap);
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
    fromCache: !!snap.fromCache,  // serving the last saved snapshot, no live pull yet
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
// tempering pipeline), every pallet line, biggest products, manager-defined
// product groups, and a one-line summary per location. Pure RAM reads over
// ~1.7k rows — cheap enough to recompute per request, zero extra Swarmbox load.
function overview(groupDefs) {
  const addW = (map, uom, qty) => { if (uom) map.set(uom, (map.get(uom) || 0) + qty); };
  const wArr = (map) => [...map.entries()].map(([uom, qty]) => ({ uom, qty }));

  // The tempering clock, mirrored from the UI: TEMP for 6+ days is "red".
  // Swarmbox dates are date-only strings, so day precision is all there is.
  const daysSince = (d) => {
    if (!d) return null;
    const t = new Date(String(d).length <= 10 ? d + 'T00:00:00' : d).getTime();
    return Number.isFinite(t) ? Math.floor((Date.now() - t) / 86400000) : null;
  };
  const isRed = (r) => {
    if (r.state !== 'TEMP') return false;
    const days = daysSince(r.stateDate);
    return days != null && days >= 6;
  };

  const totalsW = new Map();
  const allPallets = new Set();
  const allProducts = new Set();
  let units = 0;

  const states = new Map();   // state -> { units, pallets:Set, weight:Map }
  const products = new Map(); // item  -> { item, description, units, pallets:Set, weight:Map }
  const pallets = new Map();  // pallet|item -> { pallet, item, locations:Set, date, state, stateDate, units, cases:Map, weight:Map, red }
  const locations = [];

  // Manager groups: index item code -> the groups that contain it, so the main
  // row loop below can accumulate group totals in the same single pass.
  const gAgg = (groupDefs || []).map((g) => ({
    id: g.id, name: g.name, items: g.items, updatedBy: g.updatedBy, updatedAt: g.updatedAt,
    units: 0, pallets: new Set(), redPallets: new Set(), cases: new Map(), weight: new Map(),
    perItem: new Map(), // item -> { units, pallets:Set, cases:Map, weight:Map, red:Set }
  }));
  const groupsByItem = new Map();
  for (const g of gAgg) for (const it of g.items) {
    let arr = groupsByItem.get(it);
    if (!arr) { arr = []; groupsByItem.set(it, arr); }
    arr.push(g);
  }

  for (const [code, rows] of snap.byLocation) {
    const loc = { code, products: new Set(), pallets: new Set(), units: rows.length,
      weight: new Map(), states: new Set(), oldest: null,
      items: new Map() }; // item -> the per-product breakdown the dashboard expands inline
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

      // Same numbers as the location row, split by product — so "3 products,
      // 2 pallets" can be opened where it's read instead of loading the feed
      // page for every bin.
      let li = loc.items.get(r.item);
      if (!li) {
        li = { item: r.item, description: snap.itemDesc.get(r.item) || '', units: 0,
          pallets: new Set(), cases: new Map(), weight: new Map(),
          states: new Set(), oldest: null, red: false };
        loc.items.set(r.item, li);
      }
      li.units++; if (r.pallet) li.pallets.add(r.pallet);
      addW(li.cases, r.baseUom, r.baseQty); addW(li.weight, r.varUom, r.varQty);
      li.states.add(st);
      if (r.date && (!li.oldest || r.date < li.oldest)) li.oldest = r.date;
      if (isRed(r)) li.red = true;

      // One row per pallet+item. The same pallet can carry two products (two
      // rows) and — rarely — one pallet+item can straddle two bins, so the
      // location is a set: collapsing it to the first bin read would hide half
      // the stock from whoever goes looking for it.
      const pk = (r.pallet || '~') + '|' + r.item;
      let pa = pallets.get(pk);
      if (!pa) {
        pa = { pallet: r.pallet, item: r.item, description: snap.itemDesc.get(r.item) || '',
          locations: new Set(), date: r.date, state: r.state, stateDate: r.stateDate,
          units: 0, cases: new Map(), weight: new Map(), red: false };
        pallets.set(pk, pa);
      }
      pa.locations.add(code);
      pa.units++; addW(pa.cases, r.baseUom, r.baseQty); addW(pa.weight, r.varUom, r.varQty);
      if (r.date && (!pa.date || r.date < pa.date)) pa.date = r.date;
      // Keep the earliest state date so the clock shown matches the red flag
      // below, which trips on any row of the group.
      if (r.stateDate && (!pa.stateDate || r.stateDate < pa.stateDate)) {
        pa.stateDate = r.stateDate; pa.state = r.state;
      }
      if (isRed(r)) pa.red = true;

      for (const g of groupsByItem.get(r.item) || []) {
        g.units++; addW(g.cases, r.baseUom, r.baseQty); addW(g.weight, r.varUom, r.varQty);
        if (r.pallet) { g.pallets.add(r.pallet); if (isRed(r)) g.redPallets.add(r.pallet); }
        let gi = g.perItem.get(r.item);
        if (!gi) { gi = { units: 0, pallets: new Set(), cases: new Map(), weight: new Map(), red: new Set() }; g.perItem.set(r.item, gi); }
        gi.units++; if (r.pallet) gi.pallets.add(r.pallet); addW(gi.cases, r.baseUom, r.baseQty); addW(gi.weight, r.varUom, r.varQty);
        if (isRed(r) && r.pallet) gi.red.add(r.pallet);
      }
    }
    locations.push({
      code, products: loc.products.size, pallets: loc.pallets.size, units: loc.units,
      weight: wArr(loc.weight), states: [...loc.states].sort(), oldest: loc.oldest,
      items: [...loc.items.values()]
        .sort((a, b) => (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))
        .map((i) => ({
          item: i.item, description: i.description, units: i.units, pallets: i.pallets.size,
          cases: wArr(i.cases), weight: wArr(i.weight),
          states: [...i.states].sort(), oldest: i.oldest, red: i.red,
        })),
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

  // Every pallet+item line on hand, oldest first, nothing capped — the
  // dashboard filters and pages this client-side. A manager hunting one pallet
  // needs it to be present, not just the fifteen that have sat longest.
  // Undated lines sort last rather than disappearing.
  const palletRows = [...pallets.values()]
    .sort((a, b) => (a.date === b.date ? 0 : !a.date ? 1 : !b.date ? -1 : a.date < b.date ? -1 : 1)
      || (a.item < b.item ? -1 : a.item > b.item ? 1 : 0))
    .map((p) => ({ ...p, locations: [...p.locations].sort(), cases: wArr(p.cases), weight: wArr(p.weight) }));

  // Every product in the snapshot (GT is ~30 items) — feeds the group editor's
  // pick list, unlike topProducts which is capped for display.
  const productList = [...products.values()]
    .sort((a, b) => (a.item < b.item ? -1 : 1))
    .map((p) => ({ item: p.item, description: p.description, pallets: p.pallets.size }));

  const groupSummaries = gAgg
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((g) => ({
      id: g.id, name: g.name, items: g.items, updatedBy: g.updatedBy, updatedAt: g.updatedAt,
      presentItems: g.perItem.size, units: g.units, pallets: g.pallets.size,
      redPallets: g.redPallets.size, cases: wArr(g.cases), weight: wArr(g.weight),
      perItem: [...g.perItem.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([item, gi]) => ({
        item, description: snap.itemDesc.get(item) || '',
        units: gi.units, pallets: gi.pallets.size, red: gi.red.size,
        cases: wArr(gi.cases), weight: wArr(gi.weight),
      })),
    }));

  return {
    ok: snap.ok, builtAt: snap.builtAt, prefix: PREFIX,
    totals: { units, pallets: allPallets.size, products: allProducts.size,
      locations: locations.length, weight: wArr(totalsW) },
    states: [...states.values()]
      .sort((a, b) => b.units - a.units)
      .map((s) => ({ state: s.state, units: s.units, pallets: s.pallets.size, weight: wArr(s.weight) })),
    palletRows, topProducts, locations, allProducts: productList, groups: groupSummaries,
  };
}

let timer = null;
function start() {
  // Serve the last good snapshot the instant we boot, then pull fresh behind
  // it. A restart or deploy no longer means a blank dashboard for whoever is
  // mid-shift and looking at it.
  const cached = loadCache();
  if (cached) {
    snap = cached;
    const mins = Math.round((Date.now() - cached.builtAt.getTime()) / 60000);
    console.log(`[Inventory] serving cached snapshot: ${cached.rowCount} rows / ${cached.locations.length} locations, ${mins} min old — refreshing now`);
  }
  refresh(); // warm on boot
  if (timer) clearInterval(timer);
  timer = setInterval(refresh, REFRESH_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, refresh, status, searchLocations, getLocation, overview };

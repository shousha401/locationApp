// slots.js — the rack itself: which bins EXIST, so the app can say what's empty.
//
// Every other part of this app is built on the Swarmbox feed, and the feed only
// ever describes stock: `inventory_detail` returns a row per pallet, indexed by
// the bin it sits in. A bin with nothing in it produces no row, so an empty slot
// is not "shown as empty" — it is absent, indistinguishable from a bin that was
// never built. That makes "how many slots are free" a question the snapshot
// structurally cannot answer, however carefully you read it: the dashboard's
// `locations.length` is the count of bins IN USE and always has been.
//
// Swarmbox has no bin master to ask, either (its API exposes demand, customers,
// vendors, inventory and production — nothing that enumerates racks). So the
// rack list has to live here. It is a physical fact about the GT freezer, not
// something derived, and it changes only when someone builds or removes racking.
//
// The grid below was confirmed against two independent readings of 4,871 logged
// snapshots since 2026-07-20: the distinct-bin count peaked at exactly 81 and
// sat at 80 more often than any other value, and the bin codes in use form a
// complete Z1–Z5 × A–D × 01–04 lattice (Z3 has been seen full, A01 through D04)
// plus the one floor spot. 80 slots + floor = the 81 ceiling, from both sides.

// Bin codes read `GT.2.<zone>.<row><position>` — five zones of four rows, four
// deep. Written as parts rather than a literal list of 80 strings so that a rack
// change is an edit to the shape, not to eighty lines.
const PREFIX = 'GT.2';
const ZONES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'];
const ROWS = ['A', 'B', 'C', 'D'];
const POSITIONS = ['01', '02', '03', '04'];

// The floor spot is a real place stock sits and a real thing to know about, but
// it is not a rack slot: it has no fixed capacity, so counting it as one would
// make "79 of 80 full" mean something different depending on where the last
// pallet landed. Tracked and reported, deliberately outside the totals.
const FLOOR = ['GT.2.Z6.FLOR'];

const code = (zone, row, pos) => `${PREFIX}.${zone}.${row}${pos}`;

// Build once at load — the rack does not change while the process runs.
const ALL = [];
for (const zone of ZONES) {
  for (const row of ROWS) {
    for (const pos of POSITIONS) ALL.push(code(zone, row, pos));
  }
}
const SLOT_SET = new Set(ALL);
const FLOOR_SET = new Set(FLOOR);

// The rack is described for GT specifically. Running the app against another
// LOCATION_PREFIX (or `*`, every location in the company) leaves these counts
// meaningless rather than wrong-but-plausible, so capacity() declines to answer
// instead — the UI hides the panel on `applies:false` rather than printing
// "40 of 80" over a warehouse this file knows nothing about.
function applies(activePrefix) {
  return String(activePrefix || '').toUpperCase() === 'GT';
}

// Fold the snapshot's occupied bins onto the rack.
//
// `occupied` is the dashboard's per-location summary rows ({ code, pallets, ... })
// — the same array the location list is drawn from, so the map and the list can
// never disagree about which bin holds what. A plain array of codes works too.
//
// Anything occupied that this file doesn't know about comes back under `unknown`
// rather than being dropped. That is the point: a bin outside the grid means the
// grid is out of date, and the one failure mode worth catching loudly is the
// rack quietly growing while the app keeps reporting a confident 80.
function capacity(occupied, activePrefix) {
  const used = new Map(); // code -> pallets on it
  for (const row of occupied || []) {
    const c = typeof row === 'string' ? row : (row && row.code);
    if (!c) continue;
    used.set(String(c).trim(), typeof row === 'object' && row ? (row.pallets || 0) : 0);
  }

  const cell = (c) => ({ code: c, used: used.has(c), pallets: used.get(c) || 0 });

  const zones = ZONES.map((zone) => {
    const rows = ROWS.map((row) => ({
      row, cells: POSITIONS.map((pos) => cell(code(zone, row, pos))),
    }));
    const cells = rows.flatMap((r) => r.cells);
    const zUsed = cells.filter((x) => x.used).length;
    return { zone, rows, total: cells.length, used: zUsed, free: cells.length - zUsed };
  });

  const usedCount = zones.reduce((n, z) => n + z.used, 0);
  const unknown = [...used.keys()].filter((c) => !SLOT_SET.has(c) && !FLOOR_SET.has(c)).sort();

  return {
    applies: applies(activePrefix),
    total: ALL.length,
    used: usedCount,
    free: ALL.length - usedCount,
    zones,
    // Read out to whoever is standing there with a pallet, so keep it in rack
    // order (Z1.A01 → Z5.D04), which is walking order, not sorted-string order.
    freeCodes: ALL.filter((c) => !used.has(c)),
    floor: FLOOR.map(cell),
    unknown,
  };
}

module.exports = { capacity, applies, ALL, FLOOR, ZONES, ROWS, POSITIONS };

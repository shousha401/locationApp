// history.js — the permanent record of who wrote what and who got it done.
//
// Everything else in this app forgets on purpose: a tick is gone after 21 days,
// a dated note after 30, and a closed job deletes itself — name, notes and all —
// a day after it ships. That keeps the board about today, and it also means
// "what did we do last Tuesday" had no answer anywhere: a tick only ever stored
// a group id, and the group it pointed at was already deleted.
//
// So every event is written here AS IT HAPPENS, carrying its own copy of the
// group's name, the note's text and the item codes. Nothing in this file is a
// reference to anything else, which is the whole point — a record that needs
// the group to still exist is not a record.
//
//   wrote / removed   — a note put on a group, or taken off it
//   done / undone     — a task ticked off, or un-ticked
//   closed / reopened — a job ending (its stock shipped, or someone ended it)
//   deleted           — a group removed by hand
//   daynote           — the manager's note for a day, written or cleared
//
// APPEND-ONLY, one JSON object per line (data/history.jsonl, gitignored). A
// line is added and never rewritten, so a crash mid-write can cost at most the
// line being written — never the months before it. Nothing here is ever pruned.
// Admins read it (history.html); nobody edits it.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'history.jsonl');

let events = [];
let existed = false; // was there a log on disk at boot — see seedOnce()

function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[History] load failed:', e.message);
    return;
  }
  existed = true;
  let bad = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    // One unreadable line is skipped, not fatal: the rest of the log is still true.
    try { events.push(JSON.parse(line)); } catch { bad++; }
  }
  if (bad) console.error(`[History] skipped ${bad} unreadable line(s)`);
}

function write(recs) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.appendFileSync(FILE, recs.map((r) => JSON.stringify(r) + '\n').join(''));
  } catch (e) {
    console.error('[History] save failed:', e.message);
  }
}

load();

// `at` may be handed in when the event already has its own timestamp (a close
// stamps the group and the record with the same instant).
function add(ev) {
  const rec = { at: new Date().toISOString(), ...ev };
  events.push(rec);
  write([rec]);
  return rec;
}

// The copy of a group that rides on its events: enough to read the record back
// once the group itself is gone.
const snap = (g) => ({ groupId: g.id, group: g.name, items: (g.items || []).slice() });

// Who wrote the note a task came from — looked up in this log, because a group
// only remembers its LAST editor. Walks backwards and stops at a `deleted`:
// group ids are handed out again (groups.js create()), so anything older than
// that belongs to a different group that happened to wear the same number.
// Null for a note written before this log existed.
function authorOf(groupId, kind, when) {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.groupId !== groupId) continue;
    if (e.type === 'deleted') return null;
    if (e.type !== 'wrote' || e.kind !== kind) continue;
    if (kind === 'dated' && e.date !== when) continue;
    if (kind === 'weekly' && e.day !== when) continue;
    return e.by || null;
  }
  return null;
}

// Everything since an instant (ISO), oldest first; everything when omitted.
function since(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return events.slice();
  return events.filter((e) => Date.parse(e.at) >= t);
}

// First boot only: bring in what the other files still remember, so the log
// does not open empty. `build` returns the events to import; each is marked
// `backfilled` because it was reconstructed after the fact rather than written
// as it happened — some of them no longer know which group they were about.
function seedOnce(build) {
  if (existed) return 0;
  existed = true;
  const recs = (build() || []).map((e) => ({ ...e, backfilled: true }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  // Ahead of anything already logged this boot, so the file stays in time order.
  events = recs.concat(events);
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, events.map((r) => JSON.stringify(r) + '\n').join(''));
  } catch (e) {
    console.error('[History] seed failed:', e.message);
  }
  return recs.length;
}

module.exports = { add, snap, authorOf, since, seedOnce };

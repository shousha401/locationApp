// today.js — the Today board's own state: what's been checked off, and the
// manager's note for the day.
//
// Two things live here, both keyed by CALENDAR DATE (YYYY-MM-DD) rather than by
// weekday, because both are about one specific day:
//
//   done  — a group's day-note ticked off by whoever did the work. The weekly
//           plan repeats every week by design (see groups.js), so a tick has to
//           expire on its own: today's "done" must not quietly hide the same
//           task next week. Dating it does that for free.
//   notes — one free-text note for the day from a manager. Editors write it,
//           everybody reads it, and it ages out instead of living forever.
//
// The date comes from the BROWSER, not the server. The board is read standing in
// front of a screen on the floor, so "today" has to be the viewer's today; the
// routes validate the shape and nothing else.
//
// App-owned like notes and groups: stored on disk (data/today-board.json,
// gitignored), never touches Swarmbox.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'today-board.json');
const MAX_NOTE = 500;
// Ticks are worth keeping only long enough to answer "was that done?" for the
// week in front of us; notes are read back further, so they live longer.
const KEEP_DONE_DAYS = 21;
const KEEP_NOTE_DAYS = 120;

let state = { done: {}, notes: {} }; // { done:{date:{gid:{by,at}}}, notes:{date:{text,by,at}} }

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (s) => DATE_RE.test(String(s || ''));

// Server-local YYYY-MM-DD, used only to decide what's old enough to drop.
function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function cutoff(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Drop what has aged out. Dates are ISO, so a string compare is a date compare.
// Anything dated in the FUTURE stays: a manager writing Friday's note on Monday
// is the normal way this gets used.
function prune() {
  const dCut = cutoff(KEEP_DONE_DAYS);
  const nCut = cutoff(KEEP_NOTE_DAYS);
  for (const d of Object.keys(state.done)) if (d < dCut) delete state.done[d];
  for (const d of Object.keys(state.notes)) if (d < nCut) delete state.notes[d];
}

function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Today] load failed:', e.message);
    return; // first run or unreadable — start empty, never overwrite on a guess
  }
  try {
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1); // tolerate a BOM
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') {
      state = { done: o.done && typeof o.done === 'object' ? o.done : {},
        notes: o.notes && typeof o.notes === 'object' ? o.notes : {} };
      prune();
    } else console.error('[Today] load failed: file is not an object');
  } catch (e) {
    console.error('[Today] load failed:', e.message);
  }
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[Today] save failed:', e.message);
  }
}

load();

// ── Done ticks ───────────────────────────────────────────────────────────────
const doneFor = (date) => (isDate(date) ? state.done[date] || {} : {});

// done=false removes the tick outright rather than storing a false — "not ticked"
// and "un-ticked" are the same state to everyone reading the board.
function setDone(date, groupId, done, who) {
  if (!isDate(date)) return { error: 'Bad date' };
  const gid = String(groupId || '').trim();
  if (!gid) return { error: 'Which task?' };
  const day = state.done[date] || (state.done[date] = {});
  if (done) day[gid] = { by: who || null, at: new Date().toISOString() };
  else delete day[gid];
  if (!Object.keys(day).length) delete state.done[date];
  prune();
  persist();
  return { date, groupId: gid, done: !!done, mark: done ? day[gid] : null };
}

// Every group's done-marks for a span of dates — the calendar's month view
// needs this in one call rather than one round-trip per visible day.
function doneRange(from, to) {
  const out = {};
  if (!isDate(from) || !isDate(to)) return out;
  for (const [d, day] of Object.entries(state.done)) if (d >= from && d <= to) out[d] = day;
  return out;
}

// ── The day's note ───────────────────────────────────────────────────────────
const noteFor = (date) => (isDate(date) && state.notes[date]) || null;

function notesRange(from, to) {
  const out = {};
  if (!isDate(from) || !isDate(to)) return out;
  for (const [d, n] of Object.entries(state.notes)) if (d >= from && d <= to) out[d] = n;
  return out;
}

// Blank text deletes the day's note — clearing the box is how a manager takes a
// note down, so it must not leave an empty line on the board.
function setNote(date, text, who) {
  if (!isDate(date)) return { error: 'Bad date' };
  const clean = String(text == null ? '' : text).trim().slice(0, MAX_NOTE);
  if (!clean) {
    delete state.notes[date];
    prune();
    persist();
    return { date, text: '', by: null, at: null };
  }
  const rec = { text: clean, by: who || null, at: new Date().toISOString() };
  state.notes[date] = rec;
  prune();
  persist();
  return { date, ...rec };
}

module.exports = { isDate, todayLocal, doneFor, doneRange, setDone, noteFor, notesRange, setNote, MAX_NOTE };

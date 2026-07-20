// requests.js — the app's build queue, and the reason it can grow without
// meetings: anyone signed in writes what they want the app to show, and the
// build side reads the thread and ships it. Same idea as valueTool's questions
// channel, pointed at features instead of numbers.
//
// It's a flat message thread, not a ticket system: Clay writes "show me X",
// the builder replies in-line, and "done" is just a checkmark an admin sets so
// answered items sink visually. Stored on disk (data/requests.json, gitignored)
// like notes — survives restarts, never ships via git.
//
// The file seeds itself with the opening interview questions on first run, so
// the queue starts as a conversation rather than an empty box.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'requests.json');
const MAX_LEN = 4000;

let messages = []; // [{ id, author, text, ts, done, doneBy, doneAt }]

const SEED_AUTHOR = 'eslam';
const SEED = [
  'Clay — this page is the build queue for this app. Write anything you want it to show and it gets built. To start us off, a few questions:',
  'What do you check first thing in the morning, and what do you still have to physically walk out to the freezer to find out?',
  'When you look up when a load got here or when it tempered — what decision does that drive? Scheduling production, a food-safety clock, chasing old stock, something else?',
  'Do you mostly think in products ("how much 85/15 do we have"), in locations ("what’s in GT-14"), or in time ("what’s ready to run tomorrow")? The dashboard will lead with whichever you actually use.',
  'What should the app flag on its own, without you asking — pallets tempering too long, stock sitting past some number of days, anything else?',
];

function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') { seed(); return; } // first run only
    console.error('[Requests] load failed:', e.message);
    return;
  }
  try {
    // Tolerate a BOM (hand-edits from PowerShell tend to add one).
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) { messages = arr; return; }
    console.error('[Requests] load failed: file is not an array');
  } catch (e) {
    console.error('[Requests] load failed:', e.message);
  }
  // A file we couldn't PARSE is not a first run — never seed over it, someone's
  // thread may be in there. Start empty in memory and leave it for recovery.
}

// The opening interview questions, written once when no file exists at all.
function seed() {
  const t0 = Date.now();
  messages = SEED.map((text, i) => ({
    id: i + 1, author: SEED_AUTHOR, text,
    ts: new Date(t0 + i).toISOString(), done: false, doneBy: null, doneAt: null,
  }));
  persist();
}

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(messages, null, 2));
  } catch (e) {
    console.error('[Requests] save failed:', e.message);
  }
}

load();

const list = () => messages.slice();

function add(author, text) {
  text = String(text || '').trim().slice(0, MAX_LEN);
  if (!text) return null;
  const id = messages.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  const msg = {
    id, author: String(author || '?').slice(0, 40), text,
    ts: new Date().toISOString(), done: false, doneBy: null, doneAt: null,
  };
  messages.push(msg);
  persist();
  return msg;
}

function setDone(id, done, who) {
  const msg = messages.find((m) => m.id === Number(id));
  if (!msg) return null;
  msg.done = !!done;
  msg.doneBy = done ? (who || null) : null;
  msg.doneAt = done ? new Date().toISOString() : null;
  persist();
  return msg;
}

module.exports = { list, add, setDone, MAX_LEN };

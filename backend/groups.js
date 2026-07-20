// groups.js — manager-named product groups: "Organic 85s", "Grassfed", whatever
// the floor actually calls things. A group is just a name plus a list of item
// codes; the dashboard aggregates the snapshot across each group so managers
// can watch a family of products as one line instead of fifteen.
//
// App-owned, like notes: stored on disk (data/product-groups.json, gitignored),
// never touches Swarmbox. Editors and admins manage them; everyone sees them.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'product-groups.json');
const MAX_NAME = 60;
const MAX_ITEMS = 300;

let groups = []; // [{ id, name, items:[codes], updatedBy, updatedAt }]

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

load();

const cleanName = (s) => String(s || '').trim().slice(0, MAX_NAME);
// Item codes as they appear in Swarmbox ('062065'); dedupe, drop blanks.
const cleanItems = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
  .map((x) => String(x || '').trim()).filter(Boolean))].slice(0, MAX_ITEMS);

const list = () => groups.slice();
const get = (id) => groups.find((g) => g.id === Number(id)) || null;
const nameTaken = (name, exceptId) => groups.some(
  (g) => g.id !== exceptId && g.name.toLowerCase() === name.toLowerCase());

function create(name, items, who) {
  name = cleanName(name);
  items = cleanItems(items);
  if (!name) return { error: 'Group needs a name' };
  if (!items.length) return { error: 'Pick at least one product' };
  if (nameTaken(name, null)) return { error: `A group called '${name}' already exists` };
  const id = groups.reduce((m, g) => Math.max(m, g.id), 0) + 1;
  const rec = { id, name, items, updatedBy: who || null, updatedAt: new Date().toISOString() };
  groups.push(rec);
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
  }
  g.updatedBy = who || null;
  g.updatedAt = new Date().toISOString();
  persist();
  return g;
}

function remove(id) {
  const g = get(id);
  if (!g) return null;
  groups = groups.filter((x) => x.id !== g.id);
  persist();
  return g;
}

module.exports = { list, get, create, update, remove };

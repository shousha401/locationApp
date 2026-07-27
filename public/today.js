// today.js — the Today board, shared by the feed and the dashboard.
//
// It is the first thing anyone sees after signing in, so it lives in one file
// rather than being written twice: whatever the floor reads on the feed is
// character-for-character what a manager reads on the dashboard.
//
// What it shows, in reading order:
//   · today's tasks — every group with a note for today (groups.js), each with
//     a ✓ that checks it off and, for editors, a ✕ that takes the note off the
//     week for good. Checked-off tasks leave the list and collapse into one
//     "N done today" line, undoable, because a mis-tap must not lose a task.
//   · the day's note — a manager's line for the day. EVERYONE reads it; only
//     editors and admins write it, through the ✎ button. There is no inline
//     editing: a viewer can't put the board into an editable state at all.
//
// "Today" is the VIEWER's today. The board is read standing in front of a screen
// on the floor, so every date sent to the API comes from this browser.
(function () {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'],
    ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
  const p2 = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const dayKey = (d) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()];
  const clock = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  // This week, Monday-anchored — the same week the group editor shows, so the
  // two note editors never disagree about which Friday they mean.
  function week() {
    const now = new Date();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    return DAYS.map(([key, label], i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return { key, label, date: ymd(d), display: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) };
    });
  }

  const CSS = `
    .tb { padding:14px 18px; border-radius:11px; background:var(--panel);
      border:1px solid var(--line); border-left:3px solid var(--accent2); }
    .tb-head { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
    .tb-head h3 { margin:0; font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); }
    .tb-head .tb-grow { flex:1 1 auto; }
    .tb-list { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:8px; }
    .tb-list li { font-size:17px; display:flex; align-items:center; gap:9px; flex-wrap:wrap; }
    .tb-g { font-weight:700; }
    .tb-arrow { color:var(--muted); }
    .tb-n { color:var(--accent2); font-weight:700; }
    .tb-none { color:var(--muted); font-size:13px; }
    /* Sized for a thumb on a floor tablet, not a mouse on a desk. */
    .tb-btn { padding:6px 13px; border-radius:999px; border:1px solid var(--line);
      background:var(--bg); color:var(--muted); cursor:pointer; font-size:12px; white-space:nowrap; }
    .tb-btn:hover { border-color:var(--accent); color:var(--accent); }
    .tb-btn.tb-x:hover { border-color:var(--err); color:var(--err); }
    .tb-btn[disabled] { opacity:.5; cursor:default; }
    .tb-donebar { margin-top:11px; }
    .tb-link { background:none; border:0; padding:0; color:var(--muted); cursor:pointer;
      font-size:12px; text-decoration:underline; }
    .tb-donelist { margin:8px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:6px; }
    .tb-donelist li { font-size:13px; display:flex; align-items:center; gap:9px; flex-wrap:wrap; color:var(--muted); }
    .tb-donelist .tb-g { font-weight:600; text-decoration:line-through; }
    .tb-meta { font-size:11px; color:var(--muted); }
    .tb-note { margin-top:12px; padding-top:11px; border-top:1px solid var(--line); font-size:15px; }
    .tb-note .tb-cap { font-size:11px; text-transform:uppercase; letter-spacing:.06em;
      color:var(--muted); margin-right:8px; }
    .tb-notetext { white-space:pre-wrap; }
    .tb-hide { display:none; }

    .tb-modal { position:fixed; inset:0; background:rgba(2,6,23,.85); display:none; z-index:60;
      align-items:center; justify-content:center; padding:20px; }
    .tb-modal.on { display:flex; }
    .tb-sheet { background:var(--panel); border:1px solid var(--line); color:var(--text);
      border-radius:14px; padding:20px 22px; width:min(94vw,580px); max-height:90vh; overflow:auto; }
    .tb-sheet h3 { margin:0 0 4px; font-size:15px; }
    .tb-sheet .tb-sub { color:var(--muted); font-size:12px; margin-bottom:14px; }
    .tb-rows { border:1px solid var(--line); border-radius:9px; overflow:hidden; }
    .tb-row { display:flex; gap:11px; padding:7px 11px; border-bottom:1px solid rgba(51,65,85,.45); }
    .tb-row:last-child { border-bottom:0; }
    .tb-row > span { width:100px; flex-shrink:0; font-size:12px; color:var(--muted);
      text-transform:uppercase; letter-spacing:.05em; padding-top:6px; }
    .tb-row > span small { font-size:10px; letter-spacing:0; text-transform:none; opacity:.7; margin-left:4px; }
    .tb-row textarea { flex:1; min-height:44px; resize:vertical; padding:7px 10px; font:inherit; font-size:13px;
      border-radius:8px; border:1px solid var(--line); background:var(--panel2); color:var(--text); }
    .tb-row textarea:focus { outline:none; border-color:var(--accent); }
    .tb-row.tb-today { background:rgba(34,211,238,.07); }
    .tb-row.tb-today > span { color:var(--accent2); font-weight:700; }
    .tb-err { color:var(--err); font-size:12px; margin-top:8px; min-height:16px; }
    .tb-actions { display:flex; gap:10px; margin-top:14px; justify-content:flex-end; }
    .tb-actions button { padding:9px 18px; border-radius:8px; border:0; cursor:pointer; font-weight:700; }
    .tb-save { background:var(--accent); color:#04222f; }
    .tb-cancel { background:none; border:1px solid var(--line) !important; color:var(--muted); }
  `;

  let EL = null;              // where the board renders
  let ME = { username: '', role: 'viewer' };
  let GROUPS = [];
  let DONE = {};              // groupId -> { by, at } for today
  let NOTES = {};             // date -> { text, by, at } for this week
  let SHOW_DONE = false;      // is the "N done today" list expanded
  let BUSY = false;           // a tick/clear is in flight — don't double-fire
  const isMgr = () => ME.role === 'editor' || ME.role === 'admin';

  function injectCss() {
    if (document.getElementById('tb-css')) return;
    const s = document.createElement('style');
    s.id = 'tb-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  async function fetchState() {
    const w = week();
    const date = ymd(new Date());
    const [g, t] = await Promise.all([
      fetch('/api/groups').then((r) => r.json()),
      fetch(`/api/today?date=${date}&from=${w[0].date}&to=${w[6].date}`).then((r) => r.json()),
    ]);
    GROUPS = (g && g.groups) || [];
    DONE = (t && t.done) || {};
    NOTES = (t && t.notes) || {};
  }

  function render() {
    if (!EL) return;
    const now = new Date();
    const k = dayKey(now);
    const date = ymd(now);
    const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const all = GROUPS.filter((g) => g.plan && g.plan[k])
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    // Checked off means gone from the list — that is the whole point of the tick.
    const open = all.filter((g) => !DONE[String(g.id)]);
    const done = all.filter((g) => DONE[String(g.id)]);
    const note = NOTES[date];
    const mgr = isMgr();

    const taskLi = (g) => `
      <li data-gid="${esc(g.id)}">
        <span class="tb-g">${esc(g.name)}</span><span class="tb-arrow">→</span>
        <span class="tb-n">${esc(g.plan[k])}</span>
        <button class="tb-btn tb-done" data-done="${esc(g.id)}" title="Check this off for today">✓ done</button>
        ${mgr ? `<button class="tb-btn tb-x" data-clear="${esc(g.id)}"
          title="Delete this note from ${esc(k.toUpperCase())} — it won't come back next week">✕</button>` : ''}
      </li>`;

    EL.innerHTML = `<div class="tb">
      <div class="tb-head">
        <h3>📋 Today · ${esc(dateStr)}</h3>
        <div class="tb-grow"></div>
        ${mgr ? '<button class="tb-btn" id="tb-editnote">✎ Notes</button>' : ''}
      </div>
      ${open.length ? `<ul class="tb-list">${open.map(taskLi).join('')}</ul>`
        : `<div class="tb-none">${done.length ? 'Everything for today is checked off.'
          : 'No tasks scheduled for today.'}</div>`}
      ${done.length ? `
        <div class="tb-donebar">
          <button class="tb-link" id="tb-toggledone">${done.length} done today · ${SHOW_DONE ? 'hide' : 'show'}</button>
        </div>
        <ul class="tb-donelist ${SHOW_DONE ? '' : 'tb-hide'}">${done.map((g) => {
          const m = DONE[String(g.id)] || {};
          return `<li><span class="tb-g">${esc(g.name)}</span>
            <span class="tb-meta">${esc(g.plan[k])}${m.by ? ` · done by ${esc(m.by)}` : ''}${m.at ? ` · ${esc(clock(m.at))}` : ''}</span>
            <button class="tb-btn" data-undo="${esc(g.id)}">undo</button></li>`;
        }).join('')}</ul>` : ''}
      ${note && note.text ? `
        <div class="tb-note"><span class="tb-cap">📌 Note</span><span class="tb-notetext">${esc(note.text)}</span>
          <span class="tb-meta">${note.by ? ` — ${esc(note.by)}` : ''}${note.at ? `, ${esc(clock(note.at))}` : ''}</span></div>`
        : (mgr ? `<div class="tb-note"><button class="tb-link" id="tb-addnote">＋ add a note for today</button></div>` : '')}
    </div>`;
    EL.classList.remove('hidden');
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function setDone(gid, done) {
    if (BUSY) return;
    BUSY = true;
    try {
      const res = await fetch('/api/today/done', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: ymd(new Date()), groupId: String(gid), done }),
      });
      if (!res.ok) return;
      // Reflect it locally so the task leaves the list on the tap, not on the
      // next poll — someone standing at the screen must see it take.
      if (done) DONE[String(gid)] = { by: ME.username, at: new Date().toISOString() };
      else delete DONE[String(gid)];
      render();
    } finally { BUSY = false; }
  }

  async function clearDay(gid) {
    const g = GROUPS.find((x) => String(x.id) === String(gid));
    if (!g) return;
    const k = dayKey(new Date());
    if (!confirm(`Remove "${g.plan[k]}" from ${g.name}?\n\n`
      + `This deletes the note off ${k.toUpperCase()} for good — it will not come back next week. `
      + `To just check it off for today, use ✓ done.`)) return;
    if (BUSY) return;
    BUSY = true;
    try {
      await fetch(`/api/groups/${encodeURIComponent(gid)}/plan/${k}`, { method: 'DELETE' });
      await refresh(true);
      if (typeof board.onChange === 'function') board.onChange();
    } finally { BUSY = false; }
  }

  // ── The note editor (editors and admins only) ──────────────────────────────
  function modal() {
    let m = document.getElementById('tb-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'tb-modal';
    m.className = 'tb-modal';
    m.innerHTML = `<div class="tb-sheet">
      <h3>Notes for the week</h3>
      <div class="tb-sub">One note per day, shown to everyone on the Today board. Read-only for viewers.</div>
      <div class="tb-rows" id="tb-noterows"></div>
      <div class="tb-err" id="tb-noteerr"></div>
      <div class="tb-actions">
        <button class="tb-cancel" id="tb-notecancel">Cancel</button>
        <button class="tb-save" id="tb-notesave">Save</button>
      </div>
    </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', (e) => { if (e.target === m) closeNotes(); });
    m.querySelector('#tb-notecancel').addEventListener('click', closeNotes);
    m.querySelector('#tb-notesave').addEventListener('click', saveNotes);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && m.classList.contains('on')) { e.stopPropagation(); closeNotes(); }
    }, true);
    return m;
  }

  function openNotes() {
    if (!isMgr()) return;
    const m = modal();
    const todayDate = ymd(new Date());
    m.querySelector('#tb-noteerr').textContent = '';
    m.querySelector('#tb-noterows').innerHTML = week().map((d) => {
      const n = NOTES[d.date];
      return `<label class="tb-row ${d.date === todayDate ? 'tb-today' : ''}">
        <span>${d.label} <small>${esc(d.display)}</small></span>
        <textarea data-date="${d.date}" maxlength="500"
          placeholder="note (optional)">${esc(n && n.text ? n.text : '')}</textarea></label>`;
    }).join('');
    m.classList.add('on');
    const t = m.querySelector(`textarea[data-date="${todayDate}"]`);
    if (t) t.focus();
  }
  const closeNotes = () => { const m = document.getElementById('tb-modal'); if (m) m.classList.remove('on'); };

  async function saveNotes() {
    const m = modal();
    const err = m.querySelector('#tb-noteerr');
    const btn = m.querySelector('#tb-notesave');
    btn.disabled = true;
    err.textContent = '';
    try {
      // Only days that actually changed get written, so saving doesn't restamp
      // every note in the week with a new author and time.
      for (const t of m.querySelectorAll('textarea[data-date]')) {
        const date = t.dataset.date;
        const was = (NOTES[date] && NOTES[date].text) || '';
        const now = t.value.trim();
        if (now === was) continue;
        const res = await fetch(`/api/today/note/${date}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: now }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { err.textContent = j.error || 'Could not save.'; return; }
      }
      closeNotes();
      await refresh(true);
    } finally { btn.disabled = false; }
  }

  // Coalesced: the dashboard mounts the board and then refreshes it again from its
  // own 60s load(), so overlapping polls share one round-trip instead of racing.
  // A refresh that FOLLOWS A WRITE passes force, because a poll already in flight
  // was sent before the write and would paint the state we just changed.
  let inFlight = null;
  function refresh(force) {
    const start = () => {
      const p = fetchState()
        .then(render, () => {}) // a failed poll leaves what's on screen alone
        .finally(() => { if (inFlight === p) inFlight = null; });
      inFlight = p;
      return p;
    };
    if (!inFlight) return start();
    return force ? inFlight.then(start, start) : inFlight;
  }

  const board = {
    onChange: null, // pages that draw the plan elsewhere reload through this
    async mount(opts) {
      EL = (opts && opts.el) || null;
      ME = (opts && opts.me) || ME;
      if (!EL) return;
      injectCss();
      EL.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.id === 'tb-toggledone') { SHOW_DONE = !SHOW_DONE; render(); return; }
        if (b.id === 'tb-editnote' || b.id === 'tb-addnote') { openNotes(); return; }
        if (b.dataset.done) { setDone(b.dataset.done, true); return; }
        if (b.dataset.undo) { setDone(b.dataset.undo, false); return; }
        if (b.dataset.clear) { clearDay(b.dataset.clear); }
      });
      await refresh(true);
    },
    refresh,
  };
  window.TodayBoard = board;
})();

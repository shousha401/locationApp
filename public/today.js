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
//     editors and admins write it. There is no inline editing here: a viewer
//     can't put the board into an editable state at all.
//
// "📅 Month" opens a calendar (any date, any month) so a manager isn't limited
// to writing this week's note, and so anyone can see what's scheduled and check
// tasks off for a day other than today. Same read/write split as above: the
// checkbox is open to everyone, the note's pencil-edit is editor/admin only.
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
  // How many days past today the "coming up" list looks. Six, not seven: a full
  // week ahead lands on today's own weekday again, so the weekly plan's tasks
  // would show twice — once big as today's, once dimmed as "next Wednesday's".
  const HORIZON = 6;

  // Parse a YYYY-MM-DD string as a LOCAL date, never via `new Date(str)` — that
  // parses as UTC and can silently shift a day in any timezone behind UTC,
  // which is exactly the kind of bug "today is the viewer's today" exists to avoid.
  const fromYmd = (s) => {
    const [y, mo, d] = String(s).split('-').map(Number);
    return new Date(y, mo - 1, d);
  };
  const dayKeyOf = (dateStr) => dayKey(fromYmd(dateStr));

  // A Mon-Sun grid for `year`/`month` (0-based), padded with the adjacent
  // month's leading/trailing days so every row is a full week — standard
  // calendar-grid shape. Always a multiple of 7 cells (4-6 rows).
  function monthGrid(year, month) {
    const first = new Date(year, month, 1);
    const lastOfMonth = new Date(year, month + 1, 0);
    const gridStart = new Date(year, month, 1 - ((first.getDay() + 6) % 7));
    const cells = [];
    const cur = new Date(gridStart);
    while (cur <= lastOfMonth || cells.length % 7 !== 0) {
      cells.push({ date: ymd(cur), day: cur.getDate(), inMonth: cur.getMonth() === month, dow: dayKey(cur) });
      cur.setDate(cur.getDate() + 1);
    }
    return cells;
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
    /* Airport-board rows: the UP NEXT task big and bright, later days dim. */
    .tb-next { margin:2px 0 4px; padding:13px 16px; border-radius:10px;
      background:rgba(34,211,238,.07); border:1px solid rgba(34,211,238,.45); }
    .tb-next-cap { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.1em;
      color:var(--accent2); margin-bottom:7px; }
    .tb-next-row { display:flex; align-items:center; gap:11px; flex-wrap:wrap; font-size:23px; }
    .tb-next-row .tb-n { color:var(--accent2); }
    .tb-cap2 { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.08em;
      color:var(--muted); margin:13px 0 7px; }
    .tb-oneoff { font-size:10px; font-weight:700; padding:2px 8px; border-radius:999px;
      border:1px solid #5a4514; color:var(--warn); text-transform:uppercase; letter-spacing:.05em; }
    .tb-up { margin-top:13px; padding-top:4px; border-top:1px solid var(--line); }
    .tb-uprow { display:flex; gap:12px; align-items:baseline; padding:3px 0; font-size:14px;
      color:var(--muted); flex-wrap:wrap; }
    .tb-uprow .tb-g { color:var(--text); font-weight:600; }
    .tb-upn { color:var(--muted); }
    .tb-update { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px;
      font-weight:700; color:var(--accent2); flex:0 0 96px; text-transform:uppercase; letter-spacing:.04em; }
    .tb-upnote { font-size:13px; font-style:italic; }
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

    .tb-sheet.tb-cal { width:min(96vw,640px); }
    .tb-cal-nav { display:flex; align-items:center; gap:8px; margin-bottom:4px; }
    .tb-cal-nav h3 { margin:0; font-size:15px; min-width:150px; text-align:center; }
    .tb-cal-grid { display:grid; grid-template-columns:repeat(7,1fr); gap:5px; margin-top:10px; }
    .tb-cal-dow { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:.05em;
      color:var(--muted); text-align:center; padding-bottom:4px; }
    /* Same language as the group editor's calendars: a filled accent chip for
       "selected" (not just a border, which read almost the same as "today"),
       and a distinct teal tint for "today" so the two states never look alike. */
    .tb-cal-cell { display:flex; flex-direction:column; align-items:center; justify-content:flex-start;
      gap:3px; min-height:46px; padding:5px 2px; border-radius:9px; border:1px solid var(--line);
      background:var(--panel2); color:var(--text); cursor:pointer; font:inherit;
      transition:transform .12s, background-color .12s, border-color .12s; }
    .tb-cal-cell:hover { border-color:var(--accent); transform:translateY(-1px); }
    .tb-cal-cell.tb-cal-out { opacity:.35; }
    .tb-cal-cell.tb-today:not(.tb-cal-selected) { border-color:var(--accent2); background:rgba(34,211,238,.08); }
    .tb-cal-cell.tb-today:not(.tb-cal-selected) .tb-cal-daynum { color:var(--accent2); }
    .tb-cal-cell.tb-cal-selected { border-color:var(--accent); background:var(--accent);
      box-shadow:0 3px 12px rgba(56,189,248,.35); }
    .tb-cal-cell.tb-cal-selected .tb-cal-daynum,
    .tb-cal-cell.tb-cal-selected .tb-cal-count { color:#04222f; }
    .tb-cal-cell.tb-cal-selected .tb-cal-dot:not(.tb-cal-done):not(.tb-cal-note) { background:#04222f; }
    .tb-cal-daynum { font-size:13px; font-weight:700; }
    .tb-cal-marks { display:flex; align-items:center; gap:3px; min-height:8px; }
    .tb-cal-dot { width:6px; height:6px; border-radius:50%; background:var(--accent2); }
    .tb-cal-dot.tb-cal-done { background:var(--good); }
    .tb-cal-dot.tb-cal-note { background:var(--warn); }
    .tb-cal-count { font-size:9px; color:var(--muted); }
    .tb-cal-detail { margin-top:14px; padding-top:12px; border-top:1px solid var(--line); }
    .tb-cal-detail h4 { margin:0 0 8px; font-size:13px; }
    .tb-cal-tasklist { margin:0 0 12px; padding:0; list-style:none; display:flex; flex-direction:column; gap:7px; }
    .tb-cal-tasklist label { display:flex; align-items:center; gap:9px; font-size:15px; flex-wrap:wrap; }
    /* Named -notecard, not -note: "tb-cal-note" is already taken by the dot
       marker for "this date has a note" (see .tb-cal-dot.tb-cal-note above) —
       reusing it for this wrapper too would make the two impossible to
       tell apart by class name alone. */
    .tb-cal-notecard { margin-top:12px; padding:12px 14px; border-radius:10px;
      border:1px solid var(--line); background:var(--panel2); }
    .tb-cal-notecard .tb-cap { display:block; font-size:12px; font-weight:700; color:var(--accent2);
      text-transform:none; letter-spacing:0; margin:0 0 6px; }
    .tb-cal-notecard textarea { width:100%; min-height:70px; margin-top:8px; resize:vertical; padding:9px 11px;
      font:inherit; font-size:13px; border-radius:8px; border:1px solid var(--line);
      background:var(--bg); color:var(--text); }
    .tb-cal-notecard textarea:focus { outline:none; border-color:var(--accent); }
    .tb-cal-noteactions { display:flex; gap:8px; margin-top:8px; justify-content:flex-end; }
  `;

  let EL = null;              // where the board renders
  let ME = { username: '', role: 'viewer' };
  let GROUPS = [];
  let DONE = {};              // task key -> { by, at } for today
  let RANGE = {};             // date -> { key: {by,at} } for today..today+HORIZON
  let NOTES = {};             // date -> { text, by, at } for today..today+HORIZON
  let SHOW_DONE = false;      // is the "N done today" list expanded
  let BUSY = false;           // a tick/clear is in flight — don't double-fire
  const isMgr = () => ME.role === 'editor' || ME.role === 'admin';

  // Every task on a given DATE — the weekly plan's note for that weekday plus
  // any one-off note pinned to that exact date. Shared by today's list, the
  // "coming up" list and the month calendar so "what's scheduled" is resolved
  // exactly one way. Each task carries its own done-tick `key`: the plain group
  // id for weekly tasks (matches every tick already stored), and a `d:`-prefixed
  // id for one-offs so ticking one never hides the other on the same day.
  function tasksOnDate(dateStr) {
    const dow = dayKeyOf(dateStr);
    const out = [];
    for (const g of GROUPS) {
      if (g.plan && g.plan[dow]) out.push({ g, key: String(g.id), text: g.plan[dow], oneOff: false });
      if (g.dates && g.dates[dateStr]) out.push({ g, key: 'd:' + g.id, text: g.dates[dateStr], oneOff: true });
    }
    return out.sort((a, b) => String(a.g.name).localeCompare(String(b.g.name))
      || (a.oneOff ? 1 : 0) - (b.oneOff ? 1 : 0));
  }

  // The month calendar's own state — separate from DONE/NOTES (which back the
  // always-visible, frequently-polled single-day view) so opening/navigating
  // the calendar never changes that view's fetch behavior. See saveDayNote()/
  // setDoneOn() for the one place they deliberately stay in sync: today.
  let CAL = { year: 0, month: 0, done: {}, notes: {}, selected: null, editing: false, loading: false, error: '' };

  function injectCss() {
    if (document.getElementById('tb-css')) return;
    const s = document.createElement('style');
    s.id = 'tb-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  async function fetchState() {
    const date = ymd(new Date());
    const end = new Date();
    end.setDate(end.getDate() + HORIZON);
    const [g, t] = await Promise.all([
      fetch('/api/groups').then((r) => r.json()),
      fetch(`/api/today?date=${date}&from=${date}&to=${ymd(end)}`).then((r) => r.json()),
    ]);
    GROUPS = (g && g.groups) || [];
    DONE = (t && t.done) || {};
    RANGE = (t && t.doneRange) || {};
    NOTES = (t && t.notes) || {};
  }

  // The "coming up" strip under today — the next HORIZON days that actually
  // have something on them, airport-departures style: date on the left, task
  // on the right, dimmer than today because nobody acts on Friday's row on a
  // Wednesday. Pre-ticked tasks (via the calendar) stay out of it.
  function comingUpHtml() {
    const d = new Date();
    const days = [];
    for (let i = 1; i <= HORIZON; i++) {
      d.setDate(d.getDate() + 1);
      const date = ymd(d);
      const doneMap = RANGE[date] || {};
      const tasks = tasksOnDate(date).filter((t) => !doneMap[t.key]);
      const note = NOTES[date];
      if (!tasks.length && !(note && note.text)) continue;
      const label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      const rows = [];
      tasks.forEach((t, i2) => rows.push(`
        <div class="tb-uprow">
          <span class="tb-update">${i2 === 0 ? esc(label) : ''}</span>
          <span class="tb-g">${esc(t.g.name)}</span><span class="tb-arrow">→</span>
          <span class="tb-upn">${esc(t.text)}</span>${t.oneOff ? '<span class="tb-oneoff">one-off</span>' : ''}
        </div>`));
      if (note && note.text) rows.push(`
        <div class="tb-uprow">
          <span class="tb-update">${tasks.length ? '' : esc(label)}</span>
          <span class="tb-upnote">📌 ${esc(note.text)}</span>
        </div>`);
      days.push(rows.join(''));
    }
    if (!days.length) return '';
    return `<div class="tb-up"><div class="tb-cap2">Coming up</div>${days.join('')}</div>`;
  }

  function render() {
    if (!EL) return;
    const now = new Date();
    const k = dayKey(now);
    const date = ymd(now);
    const dateStr = now.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const all = tasksOnDate(date);
    // Checked off means gone from the list — that is the whole point of the tick.
    const open = all.filter((t) => !DONE[t.key]);
    const done = all.filter((t) => DONE[t.key]);
    const note = NOTES[date];
    const mgr = isMgr();

    // Airport-board split: the first open task is the big UP NEXT row, the rest
    // of today queues under it, and later days dim below (comingUpHtml).
    const next = open[0] || null;
    const rest = open.slice(1);

    const btns = (t) => `
      <button class="tb-btn tb-done" data-done="${esc(t.key)}" title="Check this off for today">✓ done</button>
      ${mgr ? (t.oneOff
        ? `<button class="tb-btn tb-x" data-clearoneoff="${esc(t.g.id)}"
            title="Delete this one-off note from ${esc(date)} for good">✕</button>`
        : `<button class="tb-btn tb-x" data-clear="${esc(t.g.id)}"
            title="Delete this note from ${esc(k.toUpperCase())} — it won't come back next week">✕</button>`) : ''}`;

    const taskBody = (t) => `
      <span class="tb-g">${esc(t.g.name)}</span><span class="tb-arrow">→</span>
      <span class="tb-n">${esc(t.text)}</span>${t.oneOff ? '<span class="tb-oneoff">one-off</span>' : ''}`;

    EL.innerHTML = `<div class="tb">
      <div class="tb-head">
        <h3>📋 Today · ${esc(dateStr)}</h3>
        <div class="tb-grow"></div>
        <button class="tb-btn" id="tb-cal-open">📅 Month</button>
      </div>
      ${next ? `
        <div class="tb-next">
          <div class="tb-next-cap">▸ Up next</div>
          <div class="tb-next-row">${taskBody(next)}${btns(next)}</div>
        </div>` : `<div class="tb-none">${done.length ? 'Everything for today is checked off. ✅'
          : 'No tasks scheduled for today.'}</div>`}
      ${rest.length ? `<div class="tb-cap2">Also today</div>
        <ul class="tb-list">${rest.map((t) => `<li>${taskBody(t)}${btns(t)}</li>`).join('')}</ul>` : ''}
      ${done.length ? `
        <div class="tb-donebar">
          <button class="tb-link" id="tb-toggledone">${done.length} done today · ${SHOW_DONE ? 'hide' : 'show'}</button>
        </div>
        <ul class="tb-donelist ${SHOW_DONE ? '' : 'tb-hide'}">${done.map((t) => {
          const m = DONE[t.key] || {};
          return `<li><span class="tb-g">${esc(t.g.name)}</span>
            <span class="tb-meta">${esc(t.text)}${m.by ? ` · done by ${esc(m.by)}` : ''}${m.at ? ` · ${esc(clock(m.at))}` : ''}</span>
            <button class="tb-btn" data-undo="${esc(t.key)}">undo</button></li>`;
        }).join('')}</ul>` : ''}
      ${note && note.text ? `
        <div class="tb-note"><span class="tb-cap">📌 Note</span><span class="tb-notetext">${esc(note.text)}</span>
          <span class="tb-meta">${note.by ? ` — ${esc(note.by)}` : ''}${note.at ? `, ${esc(clock(note.at))}` : ''}</span></div>`
        : (mgr ? `<div class="tb-note"><button class="tb-link" id="tb-addnote">＋ add a note for today</button></div>` : '')}
      ${comingUpHtml()}
    </div>`;
    EL.classList.remove('hidden');
  }

  // ── Actions ────────────────────────────────────────────────────────────────
  async function postDone(date, gid, done) {
    const res = await fetch('/api/today/done', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date, groupId: String(gid), done }),
    });
    return res.ok;
  }

  // Today's list only — same signature/behavior as before the calendar existed.
  async function setDone(gid, done) {
    if (BUSY) return;
    BUSY = true;
    try {
      if (!(await postDone(ymd(new Date()), gid, done))) return;
      // Reflect it locally so the task leaves the list on the tap, not on the
      // next poll — someone standing at the screen must see it take.
      if (done) DONE[String(gid)] = { by: ME.username, at: new Date().toISOString() };
      else delete DONE[String(gid)];
      render();
    } finally { BUSY = false; }
  }

  // The calendar's generalized version — any date, past/present/future.
  async function setDoneOn(date, gid, done) {
    if (BUSY) return;
    BUSY = true;
    try {
      const ok = await postDone(date, gid, done);
      if (ok) {
        const day = CAL.done[date] || (CAL.done[date] = {});
        if (done) day[String(gid)] = { by: ME.username, at: new Date().toISOString() };
        else { delete day[String(gid)]; if (!Object.keys(day).length) delete CAL.done[date]; }
        // Keep the board in sync: DONE feeds today's list, RANGE feeds the
        // "coming up" strip — a tick made in the calendar must show in both.
        if (date === ymd(new Date())) {
          if (done) DONE[String(gid)] = day[String(gid)];
          else delete DONE[String(gid)];
        }
        const rday = RANGE[date] || (RANGE[date] = {});
        if (done) rday[String(gid)] = day[String(gid)];
        else { delete rday[String(gid)]; if (!Object.keys(rday).length) delete RANGE[date]; }
        render();
      }
      // Always re-render — on failure this reverts the checkbox's already-
      // flipped visual state back to what actually happened server-side.
      renderCalendarBody();
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

  // Delete today's ONE-OFF note off a group for good — the dated cousin of
  // clearDay. Goes through the group update route because one-offs live in the
  // group's `dates` field (editor/admin only, like the ✕ that calls it).
  async function clearOneOff(gid) {
    const g = GROUPS.find((x) => String(x.id) === String(gid));
    const date = ymd(new Date());
    if (!g || !g.dates || !g.dates[date]) return;
    if (!confirm(`Remove "${g.dates[date]}" from ${g.name}?\n\n`
      + `This deletes the one-off note for today (${date}) for good. `
      + `To just check it off, use ✓ done.`)) return;
    if (BUSY) return;
    BUSY = true;
    try {
      const dates = { ...g.dates };
      delete dates[date];
      await fetch(`/api/groups/${encodeURIComponent(gid)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dates }),
      });
      await refresh(true);
      if (typeof board.onChange === 'function') board.onChange();
    } finally { BUSY = false; }
  }

  // ── The month calendar ──────────────────────────────────────────────────────
  // Everyone can open it and check tasks off for any date; only editors and
  // admins can write that date's note (gated inline in renderCalendarBody()).
  function modal() {
    let m = document.getElementById('tb-modal');
    if (m) return m;
    m = document.createElement('div');
    m.id = 'tb-modal';
    m.className = 'tb-modal';
    m.innerHTML = `<div class="tb-sheet tb-cal" id="tb-cal-sheet">
      <div class="tb-cal-nav">
        <button class="tb-btn" id="tb-cal-prev" title="Previous month">‹</button>
        <h3 id="tb-cal-title"></h3>
        <button class="tb-btn" id="tb-cal-next" title="Next month">›</button>
        <div class="tb-grow"></div>
        <button class="tb-btn" id="tb-cal-today">Today</button>
      </div>
      <div class="tb-sub">Tap a date for its tasks and note. Anyone can check a task off for any date;
        only editors and admins can write the note.</div>
      <div class="tb-err" id="tb-cal-err"></div>
      <div class="tb-cal-grid" id="tb-cal-grid"></div>
      <div class="tb-cal-detail" id="tb-cal-detail"></div>
      <div class="tb-actions"><button class="tb-cancel" id="tb-cal-close">Close</button></div>
    </div>`;
    document.body.appendChild(m);

    // The modal lives outside EL (appended to document.body), so it gets its
    // own delegated listeners rather than sharing board.mount's — same "one
    // listener, not one per rendered element" pattern as the rest of this file.
    m.addEventListener('click', (e) => {
      if (e.target === m) return closeCalendar();
      const cell = e.target.closest('[data-cal-day]');
      if (cell) return selectDay(cell.dataset.calDay);
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'tb-cal-close') return closeCalendar();
      if (btn.id === 'tb-cal-prev') return navMonth(-1);
      if (btn.id === 'tb-cal-next') return navMonth(1);
      if (btn.id === 'tb-cal-today') return jumpToday();
      if (btn.dataset.calEditnote) { CAL.editing = true; return renderCalendarBody(); }
      if (btn.dataset.calCanceledit) { CAL.editing = false; return renderCalendarBody(); }
      if (btn.dataset.calSavenote) return saveDayNote();
    });
    m.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type=checkbox][data-cal-done]');
      if (!cb || !CAL.selected) return;
      if (BUSY) { cb.checked = !cb.checked; return; } // undo the browser's optimistic flip
      setDoneOn(CAL.selected, cb.dataset.calDone, cb.checked);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && m.classList.contains('on')) { e.stopPropagation(); closeCalendar(); }
    }, true);
    return m;
  }

  function openCalendar() {
    const m = modal();
    const now = new Date();
    CAL.year = now.getFullYear();
    CAL.month = now.getMonth();
    CAL.selected = ymd(now);
    CAL.editing = false;
    CAL.error = '';
    m.classList.add('on');
    loadCalendarMonth();
  }
  function closeCalendar() {
    CAL.editing = false;
    const m = document.getElementById('tb-modal');
    if (m) m.classList.remove('on');
  }
  const calOpen = () => { const m = document.getElementById('tb-modal'); return !!(m && m.classList.contains('on')); };

  function navMonth(delta) {
    if (CAL.loading) return;
    const d = new Date(CAL.year, CAL.month + delta, 1);
    CAL.year = d.getFullYear();
    CAL.month = d.getMonth();
    CAL.selected = null; // the old selection may not fall inside the new grid's fetched range
    loadCalendarMonth();
  }
  function jumpToday() {
    if (CAL.loading) return;
    const now = new Date();
    CAL.year = now.getFullYear();
    CAL.month = now.getMonth();
    CAL.selected = ymd(now);
    loadCalendarMonth();
  }

  async function loadCalendarMonth() {
    const reqYear = CAL.year;
    const reqMonth = CAL.month;
    const grid = monthGrid(reqYear, reqMonth);
    CAL.loading = true;
    CAL.error = '';
    renderCalendarBody(); // paint the new month's dates immediately; marks fill in once loaded
    try {
      const from = grid[0].date;
      const to = grid[grid.length - 1].date;
      const j = await (await fetch(`/api/today?date=${ymd(new Date())}&from=${from}&to=${to}`)).json();
      if (reqYear !== CAL.year || reqMonth !== CAL.month) return; // superseded by a later nav
      CAL.done = (j && j.doneRange) || {};
      CAL.notes = (j && j.notes) || {};
    } catch {
      if (reqYear !== CAL.year || reqMonth !== CAL.month) return;
      CAL.error = 'Could not load this month.';
    } finally {
      if (reqYear === CAL.year && reqMonth === CAL.month) { CAL.loading = false; renderCalendarBody(); }
    }
  }

  function renderCalendarBody() {
    const m = document.getElementById('tb-modal');
    if (!m) return;
    const grid = monthGrid(CAL.year, CAL.month);
    const todayDate = ymd(new Date());
    const mgr = isMgr();

    m.querySelector('#tb-cal-title').textContent =
      new Date(CAL.year, CAL.month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    m.querySelector('#tb-cal-err').textContent = CAL.error;
    m.querySelector('#tb-cal-prev').disabled = CAL.loading;
    m.querySelector('#tb-cal-next').disabled = CAL.loading;

    const dowHeader = DAYS.map(([, label]) => `<div class="tb-cal-dow">${label}</div>`).join('');
    const cellHtml = grid.map((c) => {
      const tasks = tasksOnDate(c.date);
      const doneMap = CAL.done[c.date] || {};
      const doneCount = tasks.filter((t) => doneMap[t.key]).length;
      const openCount = tasks.length - doneCount;
      const hasNote = !!(CAL.notes[c.date] && CAL.notes[c.date].text);
      const cls = ['tb-cal-cell',
        !c.inMonth ? 'tb-cal-out' : '',
        c.date === todayDate ? 'tb-today' : '',
        c.date === CAL.selected ? 'tb-cal-selected' : ''].filter(Boolean).join(' ');
      const marks = [
        tasks.length && openCount > 0
          ? `<span class="tb-cal-dot"></span><span class="tb-cal-count">${openCount}</span>` : '',
        tasks.length && openCount === 0 ? '<span class="tb-cal-dot tb-cal-done"></span>' : '',
        hasNote ? '<span class="tb-cal-dot tb-cal-note"></span>' : '',
      ].join('');
      return `<button type="button" class="${cls}" data-cal-day="${c.date}">
        <span class="tb-cal-daynum">${c.day}</span><span class="tb-cal-marks">${marks}</span></button>`;
    }).join('');
    m.querySelector('#tb-cal-grid').innerHTML = dowHeader + cellHtml;

    const detail = m.querySelector('#tb-cal-detail');
    if (!CAL.selected) { detail.innerHTML = '<div class="tb-none">Pick a date to see its tasks.</div>'; return; }
    const tasks = tasksOnDate(CAL.selected);
    const doneMap = CAL.done[CAL.selected] || {};
    const note = CAL.notes[CAL.selected];
    const label = fromYmd(CAL.selected).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

    detail.innerHTML = `
      <h4>${esc(label)}</h4>
      ${tasks.length ? `<ul class="tb-cal-tasklist">${tasks.map((t) => {
        const mark = doneMap[t.key];
        return `<label>
          <input type="checkbox" data-cal-done="${esc(t.key)}" ${mark ? 'checked' : ''}>
          <span class="tb-g">${esc(t.g.name)}</span><span class="tb-arrow">→</span><span class="tb-n">${esc(t.text)}</span>
          ${t.oneOff ? '<span class="tb-oneoff">one-off</span>' : ''}
          ${mark && mark.by ? `<span class="tb-meta">done by ${esc(mark.by)}${mark.at ? ` · ${esc(clock(mark.at))}` : ''}</span>` : ''}
        </label>`;
      }).join('')}</ul>` : '<div class="tb-none">No tasks scheduled for this date.</div>'}
      <div class="tb-cal-notecard">
        <span class="tb-cap">📌 Note</span>
        ${CAL.editing ? `
          <textarea id="tb-cal-notebox" maxlength="500"
            placeholder="note (optional)">${esc(note && note.text ? note.text : '')}</textarea>
          <div class="tb-cal-noteactions">
            <button class="tb-cancel" data-cal-canceledit="1">Cancel</button>
            <button class="tb-save" data-cal-savenote="1">Save</button>
          </div>` : `
          <span class="tb-notetext">${note && note.text ? esc(note.text) : '<span class="tb-none">No note for this date.</span>'}</span>
          ${mgr ? '<button class="tb-link" data-cal-editnote="1">✎ edit</button>' : ''}`}
      </div>`;
  }

  function selectDay(date) {
    CAL.selected = date;
    CAL.editing = false;
    renderCalendarBody();
  }

  async function saveDayNote() {
    const m = document.getElementById('tb-modal');
    const box = m.querySelector('#tb-cal-notebox');
    if (!box || !CAL.selected) return;
    const date = CAL.selected;
    const text = box.value.trim();
    try {
      const res = await fetch(`/api/today/note/${date}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { CAL.error = j.error || 'Could not save.'; renderCalendarBody(); return; }
      if (text) CAL.notes[date] = { text, by: ME.username, at: new Date().toISOString() };
      else delete CAL.notes[date];
      CAL.editing = false;
      // Keep the top board's note in sync when the edited date is today.
      if (date === ymd(new Date())) { NOTES[date] = CAL.notes[date]; render(); }
      renderCalendarBody();
    } catch {
      CAL.error = 'Could not save.';
      renderCalendarBody();
    }
  }

  // Coalesced: the dashboard mounts the board and then refreshes it again from its
  // own 60s load(), so overlapping polls share one round-trip instead of racing.
  // A refresh that FOLLOWS A WRITE passes force, because a poll already in flight
  // was sent before the write and would paint the state we just changed.
  let inFlight = null;
  function refresh(force) {
    const start = () => {
      const p = fetchState()
        // A failed poll leaves what's on screen alone. An open calendar also
        // repaints, so an edit made elsewhere (e.g. a group's weekly plan
        // changed in the dashboard's group editor) shows up live.
        .then(() => { render(); if (calOpen()) renderCalendarBody(); }, () => {})
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
        if (b.id === 'tb-cal-open') { openCalendar(); return; }
        if (b.id === 'tb-addnote') { openCalendar(); CAL.editing = true; renderCalendarBody(); return; }
        if (b.dataset.done) { setDone(b.dataset.done, true); return; }
        if (b.dataset.undo) { setDone(b.dataset.undo, false); return; }
        if (b.dataset.clearoneoff) { clearOneOff(b.dataset.clearoneoff); return; }
        if (b.dataset.clear) { clearDay(b.dataset.clear); }
      });
      await refresh(true);
    },
    refresh,
  };
  window.TodayBoard = board;
})();

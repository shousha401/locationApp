# Location Feed

A live view of **Swarmbox inventory by location**. Type a bin code (e.g. `TC.22.L.02`)
and see exactly what's sitting there right now — items, quantities, state
(FRESH/FROZEN/TEMP, with the date each unit entered that state), received dates,
pallet count — refreshing on its own. Deliberately **no cost/value data**.
`editor`s can attach **notes and status flags** to a location; `viewer`s see them
read-only.

Three pages, all behind the same login. The feed and the dashboard both open with
the **Today board** (below), so signing in starts with what has to happen today:

- **📍 Feed** (`/`) — one location's contents, grouped by pallet, scannable barcodes.
  Deep-linkable: `/?loc=GT.2.Z2.C03` opens straight on that bin.
- **📊 Dashboard** (`/dashboard.html`) — whole-warehouse aggregates from the same
  snapshot: totals, the frozen→temp state mix, oldest pallets (tempering clock:
  TEMP 6+ days shows red), biggest products, **manager-named product groups**
  (editors pick items, name the set, and watch it as one line — with a red count;
  a grouped product reads under its group and is no longer listed on its own; a
  group with nothing on hand folds away behind a counted "N groups with nothing on
  hand · show" line, and editors get **✕** on any group row to remove it). Opening a
  group lists **the pallets themselves**, banded by their **since date** — when the
  pallet entered the state it is in: item code, **pallet ID**, bin, received date,
  state and its clock. Folding by item answers "how much of this have we got" but
  never "which pallet, and is this the lot that went into temper on Tuesday" — and
  that second question is the one the floor works to, because pallets tempering since
  the 1st are ready before ones from the 2nd. Receipt date is the wrong axis for it:
  one real lot here splits 4/3 by since-date while both halves were received on the
  same day, and banding G2 Material by receipt scattered a single job across fourteen
  bands. Oldest band first, since that is the one that should move first; a band
  holding a red pallet says so on its heading; undated pallets sit at the end rather
  than pretending to be old. Each code's own pallet count moves up beside it under
  the group name. Where a group holds more than one band, editors get **split off** on
  each heading — see **Splitting a batch off a group** below. Inside a
  group, an item whose stock has **left GT** stops being listed — it folds behind its
  own "N not on hand · show" line, so a group shows what is actually in the building
  rather than every code it was ever defined with. Groups **close themselves when
  their stock ships** and stock that comes back does *not* rejoin them — and the same
  rule runs one product at a time inside a group that is still open: a code whose
  stock ships is **released** from the job and folds behind its own "N shipped" line,
  dated, with a **put back** for editors. Finished jobs
  wait in a **Done** fold for a day and then delete themselves — see
  **Jobs close when they ship** below. A **Not in a group** tab lists every pallet
  no open group claims (assign an item to a group and its pallets leave the list),
  which is where returning stock reads until a manager gives it a job — and the
  group editor's pick list opens on exactly that unclaimed set when creating a
  new group, since that list is what new groups get built from. **All
  inventory** gets the width — the page runs to 1500px and its one wide column (the
  product description) wraps, so the table fits whole instead of scrolling sideways
  to reach Weight. The **all-locations** table is still there, with its one-tap zone
  buttons, but folded away behind its heading: it's reference, not a daily read.
- **💬 Requests** (`/requests.html`) — the app's build queue. Users write what they
  want the app to show; the build side reads the thread and ships it. Seeded with
  interview questions on first run.

## How it works

Swarmbox's `inventory_detail` RPC computes the whole inventory server-side and then
filters, so a per-location query costs the same as pulling everything. So instead of
hammering Swarmbox once per watched location, the app makes **one** call for the full
inventory (~250k rows / 6.5k locations) every few minutes, indexes it by location in
RAM, and serves every location instantly from that snapshot. A failed pull keeps the
last good snapshot (with a visible "as of" stamp), so a Swarmbox blip degrades to
slightly-stale, never blank.

Because it is a snapshot and not a live feed, stock scanned out keeps showing until
the next pull — up to `SNAPSHOT_REFRESH_MS` later. **⟳ Refresh** in the header of both
pages closes that gap on demand: it starts a pull and answers immediately (the pull
takes 10–15s for GT), and the page watches `/api/status` for the new snapshot rather
than holding a request open. Rate-limited to one manual pull every 30s **globally**,
not per user — the cost lands on Swarmbox, which doesn't care which of us asked.

- `backend/swarmbox.js` — PostgREST client (retries, circuit breaker, timeouts), lifted from valueTool.
- `backend/inventory.js` — the snapshot: pull → index by location; also the dashboard's `overview()` aggregates.
- `backend/notes.js` — the app's own notes/flags layer (never writes to Swarmbox).
- `backend/requests.js` — the build-queue thread (`data/requests.json`).
- `backend/groups.js` — manager-named product groups (`data/product-groups.json`), each
  carrying a `note` (the standing job, no date), `dates` (a note per exact calendar
  date) and a retired `plan` (a note per weekday). A group may be a **one-off job**
  rather than a product family — see below. Details in **The Today board**.
- `backend/today.js` — the Today board's own state (`data/today-board.json`): done
  ticks and the manager's note for the day, both keyed by calendar date.
- `public/today.js` — the Today board itself, shared by the feed and the dashboard so
  the floor and the office read exactly the same thing.
- `backend/users.js` + `backend/auth.js` — per-user login with `viewer`/`editor`/`admin` roles,
  plus a narrow `X-Api-Key` lane scoped to `/api/requests*` only.
- `public/` — the login screen, the feed, the dashboard, and the requests thread.

## Setup

```bash
npm install
cp .env.example .env        # adjust PORT / refresh interval if needed

# create at least one login (there is no self-service signup)
node scripts/add-user.js alice secret123 editor
node scripts/add-user.js bob   secret456 viewer
node scripts/add-user.js --list

npm start                   # → http://localhost:3005
```

The first inventory pull takes ~20s; the page shows a "building…" state until it lands.

## Roles

Roles are ranked — `admin` ⊇ `editor` ⊇ `viewer`.

| Role     | Can do                                                                   |
|----------|--------------------------------------------------------------------------|
| `viewer` | Search locations, see contents and notes/flags (read-only), and **check today's tasks off**. |
| `editor` | Everything a viewer can, **plus** edit notes and flags, product groups, the week's tasks, and the day notes. |
| `admin`  | Everything an editor can, **plus** manage users at **`/users.html`**.    |

Admins get a **👥 Users** link in the header: add people, set and reset their
passwords, change roles, and remove access — no CLI or server login needed.

Two deliberate guardrails:

- **Changes revoke sessions immediately.** Removing someone, changing their role,
  or resetting their password kills their live session on the spot, instead of
  leaving their cookie valid until the 12h expiry.
- **The last admin is protected.** The app refuses to delete or demote the final
  admin, so it's impossible to lock yourself out of user management from the UI.

The CLI still works (useful for bootstrapping the first admin, or if you're locked out):

```bash
node scripts/add-user.js <username> <password> [viewer|editor|admin]
node scripts/add-user.js --list
node scripts/add-user.js --remove <username>
```

Re-running `add-user.js` with an existing username resets that user's password/role.

## Config (`.env`)

| Var                  | Default                              | Meaning                                  |
|----------------------|--------------------------------------|------------------------------------------|
| `PORT`               | `3005`                               | Listen port (3010 is CMP Maintenance)    |
| `LOCATION_PREFIX`    | `GT`                                 | Only serve locations with this prefix    |
| `SNAPSHOT_REFRESH_MS`| `900000` (15 min)                    | How often to re-pull the full inventory  |
| `SWARMBOX_BASE_URL`  | `https://jdfood.swarmbox.com:443/pg-api` | Swarmbox PostgREST base             |
| `SWARMBOX_TIMEOUT_MS`| `120000`                             | Per-call timeout (the pull is big)       |
| `SESSION_TTL_MS`     | `43200000` (12h)                     | Sliding session lifetime                 |
| `API_KEY`            | unset (lane disabled)                | `X-Api-Key` for `/api/requests*` ONLY — lets the build side read/answer the queue without a browser session |

## The Today board

The first thing on the feed and the dashboard, read top to bottom:

1. **The date and the counts** — `N to do today`, `N not done`, `N done`. Read from
   across the room, this line alone answers "is there anything on me right now".
2. **⚠ Not done — carried over** — dated work from the last week that nobody ticked.
   A task used to stop being drawn the moment its date passed, so the one case worth
   shouting about was the one case the board went silent on. Each row keeps its own
   date, and its **✓** ticks it off **on that date**, not today.
3. **▸ Up next**, then **Also today** — today's open tasks, the first one full-size.
   Every task row **spells the job out**: under the note, each item code the group
   claims, with its description, how much is on hand (pallets and cases) and the bins
   it is in — plus the group's standing note, repeated there, when the row is a dated
   one. A task is a group and a note, which says what to do but not what to pick up or
   where it sits: "Pr Ribeyes → send 10 cases to CMP" sends whoever reads it off to
   find out what a Pr Ribeye is. (Managers had started typing item numbers into the
   day note by hand — the same information arriving the long way round.) A code with
   nothing behind it is still listed, saying `none on hand`, because "there is none of
   this here" is exactly what someone about to walk to a rack needs told. Absent, not
   empty, until the first snapshot lands.
4. **📌 Today's note** — the manager's line(s) for the day, in a card of its own.
5. **The week ahead** — the next seven days as one strip, **every** day drawn even
   when it holds nothing, because "is Thursday free?" is a question a list of only
   the busy days can't answer. Tapping a day opens it in the month calendar.

**Tasks** come from three places on a group (groups.js), and the board labels which:

| Kind | Written as | Shows |
|---|---|---|
| **Standing note** (`note`) | no date at all — the rule for this group | every morning, tagged **every day**, after the dated work |
| **Daily note** (`dates`) | one exact `YYYY-MM-DD` | that day only |
| Weekly plan (`plan`) | a weekday — *retired, kept working* | every week on that weekday |

A standing note needs no re-entering: the ✓ that clears it is dated like every other
tick, so it expires overnight and the job is back the next morning. It's deliberately
kept off the week strip and the month calendar — it lands on all seven days
identically, and printing it there would bury the dated work those views exist to
show; the strip states it once, as `plus N standing jobs every day`.

### Jobs close when they ship

A group matches stock by **item code** and nothing else — not a pallet, not a serial,
not a receipt date. Left alone, that means the next arrival of the same code silently
rejoins a group whose work already shipped: scan *Bellies for bacon* out, receive the
item back next week, and the finished job is back in front of the floor as though
nothing happened. That rejoin was the single most confusing thing groups did, so
closing is the **default**, not an opt-in:

- **Every group is a job** unless marked otherwise: once its stock ships, it closes —
  it stops matching stock, drops off the board, and shows as `shipped` in the group
  list. Stock that comes back reads under the **Not in a group** tab until a manager
  assigns it on purpose.
- **Product family** (a checkbox in the editor) is the opt-out for the *Grassfed
  beef* kind of group, which should pick up the next delivery. A family never closes
  itself.
- **One product at a time.** A four-code job whose first code ships is not finished —
  but that code is, so the job **releases** it: the group carries on with what is
  left, the released code stops matching, and stock of it that comes back reads under
  **Not in a group** like any other unassigned pallet. Closing at group level only
  ever caught the last code out of the door; every code before it rejoined silently,
  which is the same confusion at a size too small to close anything. Releasing the
  last code leaves the job with nothing on hand, which is exactly when it closes — so
  a one-code job behaves as it always did. A family releases nothing: picking up the
  next delivery is the whole point of one.

Four bits of state drive the closing:

- `seenStock` — **armed.** A job created before its pallets land must not close on the
  spot merely for never having had any.
- `closedAt` — **shipped.** Once armed and then empty, the job closes. A `closedBy`
  rides along only when a person closed it (below), so the editor can say who ended
  it instead of claiming the stock shipped.
- `seenItems` and `left` — the same two facts, per item code: which codes have been
  on hand, and which have shipped and when. A code is only ever released once it has
  actually been here, for the same reason `seenStock` exists one size up. What a
  group *matches* is its item list minus `left` — never the item list itself.

A job can also go **stale** without ever arming — its stock shipped before the app was
watching, or never arrived. Left open it lies in wait, and the next delivery of its
codes lands inside a forgotten group with dead dates. So an open job with nothing on
hand, nothing scheduled today or later, no standing note, and no edit in 7 days closes
itself too. A dated note from today on, or a standing note, protects a group no matter
how old it is.

Nothing reopens itself — "the code came back" is precisely the event this exists to
ignore — so a closed job stays closed until someone presses **Reopen**, which re-arms it
and puts every released code back with it. The editor also carries **Close job now**
for the other direction: end a job on the spot — usually because its stock came back
and is reading under work that already happened — without waiting for a snapshot to
call it empty. For one code rather than the whole job, a group's row folds its
released codes behind "N shipped · show" and each carries **put back**: the job counts
that code again, and lets go of it again when its stock next ships.

### Splitting a batch off a group

An item code is the right unit for "watch this product" and the wrong one for "this
lot goes back Wednesday". One code's stock arrives in batches, and the pallets that
went into temper on the 1st are ready before the ones from the 2nd — two jobs, however
much they share an item number. Nothing about a code can tell them apart.

So a group can be **pinned to a list of pallet ids**: a *batch*, holding exactly those
pallets and nothing else. There are two ways to get one. **split off** on a since-date
band inside an existing group makes one out of that band. Or build it that way from
the start: in the group editor every product row opens up (**"2 plt ▸"**) into its own
pallets — pallet id, state and since date, bin, received date — and ticking one pins
the group to it. The picker used to offer whole item codes only, which is no help when
a product's two pallets are two jobs; `071101 · 2 plt` says nothing about one of them
tempering since the 31st and the other since the 2nd.

Ticking a pallet says so, in a banner under the list: the group is a batch now, new
deliveries of the same codes will not join it, and one click takes the whole item codes
back instead. Anything already picked as a whole code is expanded into its pallets
rather than dropped. In batch mode a product's own tick means "all of its pallets", so
there is one source of truth rather than two that can disagree, and a batch is never a
*family* — "keeps collecting" and "holds exactly these pallets" are opposite
instructions. One pallet belongs to one job: pallets another batch already holds are
shown named and un-tickable, and the server refuses them too. Picking a pallet takes
everything riding on it, so a mixed pallet brings its second product's code along. The new group carries a `batch · N plt` chip; the parent keeps its
item codes, so **the next delivery still lands in the parent** and only the batch that
was split off is frozen. A batch takes no notes or dates from its parent — it has its
own schedule, and inheriting the parent's dated work would put one instruction on the
board twice.

The two must never both count the same pallet, so a pinned pallet belongs to its batch
and drops out of any ordinary group claiming the same code — in the group totals, on
the Today board's task rows, and in the **Not in a group** tab alike. Keyed by pallet
*and* item, because one physical pallet can carry two products and only one of them
may be the batch's.

A batch arms and closes on **its own pallets**: when they ship it closes, exactly like
any other job, while the parent stays open waiting for the next delivery. Splitting a
batch again is allowed (a lot re-tempered in two goes) and moves pallets out of the
first batch rather than leaving both holding them — but not all of them, since a batch
emptied that way would silently promote itself back to claiming its codes outright.
Saving a group with an empty pallet list un-pins it, which is the way back from a
split short of deleting it.

A closed job lands in the dashboard's **Done** fold — its own counted line under the
groups ("N done · show"), newest close first, every row stating when it closed and when
it deletes itself — and **removes itself 24 hours after it closed**: long enough to see
what shipped and catch a wrong close with Reopen on the same shift or the next one,
short enough that a warehouse finishing several jobs a day never opens the dashboard to
a wall of work that is already done. (It was a week, and a week of closes turned out to
be most of the group list — 28 of 33 at one point.) The countdown is real hours off the
close, not whole calendar days, because at this length "yesterday" is the difference
between three hours and twenty-seven. The row's ✕ deletes it sooner by hand. An
**empty** group that never closed is left alone — empty usually means its stock hasn't
landed yet, and its dated notes are still real scheduled work. Editors can of course
still delete any group at any time (✕ on its row, or **Delete group** in the editor),
stock or no stock. (Reused group ids can't resurrect old done-ticks: ids only come back
around when the highest-numbered groups are the ones deleted, a closed job can't be
ticked at all, and every tick is keyed by date — so a new group would have to be given
a note back-dated onto the very day its predecessor was ticked.)
State advances on the read paths (`/api/groups`, `/api/overview`) and is skipped
entirely until a snapshot exists, so an empty index can never read as "everything
shipped" and close every open job at once.

A task is a group and a date; **nothing about it is wired to the stock**, so scanning
the pallets out does not clear it — only the ✓ does. That gap is what made finished
work look outstanding, so a task whose group has **nothing on hand** now says so on the
row. It's amber, not red: an empty group usually means the job is already done and
gone. Today's and carried-over rows only — on a future date an empty group means
nothing, because stock still has time to arrive — and the marker is absent, never
false, until the first snapshot lands, so a cold start can't accuse every group of
being empty.

"Today" is the **viewer's** day: the board is read standing in front of a screen on
the floor, so every date sent to the API comes from that browser.

- **✓ done** — anyone signed in, viewers included, checks a task off. It leaves the
  list on the spot and collapses into a `N done today · show` line that records who
  ticked it and when, with an **undo** — a mis-tap must not lose a task. The tick is
  dated, so it expires on its own: today's ✓ never hides the same task next week.
- **✕** — editors only, and it rides today's rows, the carried-over rows and the week
  strip alike, because a wrong note is usually spotted days before it next fires. It
  **deletes** the note off the group for good — off that weekday for a weekly one, off
  that date for a one-off, off every future morning for a standing one. Confirmed
  before it happens, and it's the only one of the two that changes what the week says.

**The day's note** is one free-text note for the day, written by a manager and read by
everyone — and **read one line at a time**: managers use the box as a list ("Send back
Hewitt" / "Send back GCB Lamb Material"), so every line is drawn as its own row with
its own 📌, on the board, in the week strip and in the calendar alike. Run together as
one block those are two jobs wearing one instruction, and the second one is the one
that gets missed. Writing is unchanged — still one box, still one note.
**📅 Month** opens any date in any month — so Friday's note can be written on
Monday, and any day's tasks can be ticked. Viewers get no editing affordance at all —
the routes enforce it too (`403` without `editor`).

The group editor is a modal, so opening it covers the board and the group list it was
read from. It therefore carries an **Already written** panel: every note on every group
— standing ones first, then dated from today forward — with the group being edited
marked *this group*. Writing a note never has to depend on remembering the rest.

Everything here ages out on its own. Ticks and day-notes live in
`data/today-board.json` — ticks go after 21 days, notes after 120. **Closed jobs**
sit in the dashboard's Done fold and delete themselves 7 days after closing (see
above). A group's **dated
notes** go after 30 (`data/product-groups.json`, pruned on boot and on every write);
without that, a group given a new date every week accumulates a permanent list of
finished jobs, and the editor shows every one of them as though it were still pending.
Future dates are never pruned. The carry-over looks back seven days, inside the tick
retention, so a task can never outlive the ✓ that would have cleared it.

## The requests channel

`/requests.html` is a flat message thread: anyone signed in (viewers included) posts
what they want the app to show; admins can mark items done. It seeds itself with
opening interview questions on first run. Over the API-key lane:

```bash
curl -H "X-Api-Key: $KEY" http://10.14.1.184:3005/api/requests
curl -H "X-Api-Key: $KEY" -H "Content-Type: application/json" \
     -d '{"text":"Built — see the dashboard.","author":"eslam"}' \
     http://10.14.1.184:3005/api/requests
curl -H "X-Api-Key: $KEY" -X PATCH -H "Content-Type: application/json" \
     -d '{"done":true}' http://10.14.1.184:3005/api/requests/3
```

Key-authenticated requests are audit-logged (method/path/ip, never the key), same
as valueTool's channel.

## Deploy (VM + PM2, same as the rest of the fleet)

Runs on **CMP-APP02 (10.14.1.184)** alongside valueTool/formulation/clayTool.
Port map there: `3002` clayTool, `3003` formulation, `3004` valueTool,
`3010` CMP Maintenance, **`3005` locationApp**.

```bash
git clone https://github.com/shousha401/locationApp.git   # first time
cd locationApp
npm install --omit=dev
cp .env.example .env            # set PORT=3005, LOCATION_PREFIX=GT

# create the real logins (data/ never ships via git, so do this on the VM)
node scripts/add-user.js <username> <password> editor
node scripts/add-user.js <username> <password> viewer

pm2 start ecosystem.config.js   # first time
pm2 save
```

Updating later: `git pull && npm install --omit=dev && pm2 restart locationApp`.

`data/` (users, notes) and `logs/` are gitignored — they stay on the VM and don't ship via git.

## Network access (other PCs on the LAN)

The server binds to all interfaces, so once it's running the only thing standing
between it and the rest of the network is the host firewall. On the VM, in an
**Administrator** PowerShell, open the port once:

```powershell
New-NetFirewallRule -DisplayName "locationApp 3005" -Direction Inbound `
  -Protocol TCP -LocalPort 3005 -Action Allow -Profile Domain,Private
```

Then anyone on the network uses:

```
http://10.14.1.184:3005
```

Notes:
- Everything is behind the login, so exposing it on the LAN still requires an account.
- It's plain HTTP on the LAN (the session cookie is intentionally not `Secure`, so
  http works). Don't expose this to the internet.
- To confirm the port is actually free on the VM before starting: `netstat -ano | findstr :3005`.

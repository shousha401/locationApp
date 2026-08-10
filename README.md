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
  hand · show" line, and editors get **✕** on any group row to remove it), and
  a clickable **all-locations** table with one-tap zone buttons.
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

- `backend/swarmbox.js` — PostgREST client (retries, circuit breaker, timeouts), lifted from valueTool.
- `backend/inventory.js` — the snapshot: pull → index by location; also the dashboard's `overview()` aggregates.
- `backend/notes.js` — the app's own notes/flags layer (never writes to Swarmbox).
- `backend/requests.js` — the build-queue thread (`data/requests.json`).
- `backend/groups.js` — manager-named product groups (`data/product-groups.json`), each
  carrying a `note` (the standing job, no date), `dates` (a note per exact calendar
  date) and a retired `plan` (a note per weekday). See **The Today board** below.
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
everyone. **📅 Month** opens any date in any month — so Friday's note can be written on
Monday, and any day's tasks can be ticked. Viewers get no editing affordance at all —
the routes enforce it too (`403` without `editor`).

The group editor is a modal, so opening it covers the board and the group list it was
read from. It therefore carries an **Already written** panel: every note on every group
— standing ones first, then dated from today forward — with the group being edited
marked *this group*. Writing a note never has to depend on remembering the rest.

Ticks and notes live in `data/today-board.json` and age out on their own: ticks after
21 days, notes after 120. The carry-over looks back seven days, inside that retention,
so a task can never outlive the ✓ that would have cleared it.

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

# Location Feed

A live view of **Swarmbox inventory by location**. Type a bin code (e.g. `TC.22.L.02`)
and see exactly what's sitting there right now — items, quantities, state
(FRESH/FROZEN/TEMP, with the date each unit entered that state), received dates,
pallet count — refreshing on its own. Deliberately **no cost/value data**.
`editor`s can attach **notes and status flags** to a location; `viewer`s see them
read-only.

Three pages, all behind the same login:

- **📍 Feed** (`/`) — one location's contents, grouped by pallet, scannable barcodes.
  Deep-linkable: `/?loc=GT.2.Z2.C03` opens straight on that bin.
- **📊 Dashboard** (`/dashboard.html`) — whole-warehouse aggregates from the same
  snapshot: totals, the frozen→temp state mix, oldest pallets (tempering clock:
  TEMP 6+ days shows red), biggest products, **manager-named product groups**
  (editors pick items, name the set, and watch it as one line — with a red count),
  and a clickable **all-locations** table with one-tap zone buttons.
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
- `backend/groups.js` — manager-named product groups (`data/product-groups.json`).
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
| `viewer` | Search locations, see contents and notes/flags (read-only).              |
| `editor` | Everything a viewer can, **plus** edit notes and flags.                  |
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

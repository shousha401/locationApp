# Location Feed

A live view of **Swarmbox inventory by location**. Type a bin code (e.g. `TC.22.L.02`)
and see exactly what's sitting there right now — items, quantities, state
(FRESH/DRY/FROZEN), age, pallet count, and inventory value — refreshing on its own.
`editor`s can attach **notes and status flags** to a location; `viewer`s see them
read-only.

## How it works

Swarmbox's `inventory_detail` RPC computes the whole inventory server-side and then
filters, so a per-location query costs the same as pulling everything. So instead of
hammering Swarmbox once per watched location, the app makes **one** call for the full
inventory (~250k rows / 6.5k locations) every few minutes, indexes it by location in
RAM, and serves every location instantly from that snapshot. A failed pull keeps the
last good snapshot (with a visible "as of" stamp), so a Swarmbox blip degrades to
slightly-stale, never blank.

- `backend/swarmbox.js` — PostgREST client (retries, circuit breaker, timeouts), lifted from valueTool.
- `backend/inventory.js` — the snapshot: pull → index by location → group by item.
- `backend/notes.js` — the app's own notes/flags layer (never writes to Swarmbox).
- `backend/users.js` + `backend/auth.js` — per-user login with `viewer`/`editor` roles.
- `public/` — the login screen and the single-page feed.

## Setup

```bash
npm install
cp .env.example .env        # adjust PORT / refresh interval if needed

# create at least one login (there is no self-service signup)
node scripts/add-user.js alice secret123 editor
node scripts/add-user.js bob   secret456 viewer
node scripts/add-user.js --list

npm start                   # → http://localhost:3010
```

The first inventory pull takes ~20s; the page shows a "building…" state until it lands.

## Roles

| Role     | Can do                                                       |
|----------|-------------------------------------------------------------|
| `viewer` | Search locations, see contents and notes/flags (read-only). |
| `editor` | Everything a viewer can, **plus** edit notes and flags.     |

Re-running `add-user.js` with an existing username resets that user's password/role.
Remove a user with `node scripts/add-user.js --remove <username>`.

## Config (`.env`)

| Var                  | Default                              | Meaning                                  |
|----------------------|--------------------------------------|------------------------------------------|
| `PORT`               | `3010`                               | Listen port                              |
| `SNAPSHOT_REFRESH_MS`| `300000` (5 min)                     | How often to re-pull the full inventory  |
| `SWARMBOX_BASE_URL`  | `https://jdfood.swarmbox.com:443/pg-api` | Swarmbox PostgREST base             |
| `SWARMBOX_TIMEOUT_MS`| `120000`                             | Per-call timeout (the pull is big)       |
| `SESSION_TTL_MS`     | `43200000` (12h)                     | Sliding session lifetime                 |

## Deploy (VM + PM2, same as the rest of the fleet)

```bash
git pull
npm install --omit=dev
pm2 start ecosystem.config.js   # first time
pm2 restart locationApp         # updates
pm2 save
```

`data/` (users, notes) and `logs/` are gitignored — they stay on the VM and don't ship via git.

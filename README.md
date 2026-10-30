# LEUCO JUBATUS – store, admin and backend

One Node.js server that serves the storefront, the admin app (orders, stock, POS,
staff, bills, publishing) and the API they use. Data is kept in one JSON file.

## Requirements

- Node.js 18 or newer
- npm

## Quick start

```bash
npm install
ADMIN_PASSWORD='choose-a-password' npm start
```

Open http://localhost:3000 for the shop. Use **Admin** (the mode switch in the
header) and log in with the password you chose.

If you do not set `ADMIN_PASSWORD` on the first start, a random password is
generated and printed once in the console. Log in with it and change it on the
**Bills** tab.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_PASSWORD` | generated | Owner password, used only when the store has none yet (first start or after import). Minimum 4 characters. |
| `PORT` | `3000` | HTTP port. |
| `DATA_DIR` | `./data` | Where `store.json` is written. Back this folder up. |
| `COOKIE_SECURE` | off | Set to `1` when the site is served over HTTPS, so the session cookie is sent only over HTTPS. |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy, so rate limits use the real client IP. |
| `SESSION_HOURS` | `12` | How long an admin login lasts. |

## Roles

- **Owner** logs in with the owner password. Full access, including the staff list
  and the owner password.
- **Staff** log in with their own password, set by the owner on the Staff tab.
  Which tabs they see is decided by their role (as before). Staff cannot change the
  owner password or the staff list, even if they edit the page.

Passwords and staff PINs are stored as scrypt hashes. The browser never receives
them.

## Moving your data from the old single-file app

Your old data lives in the browser that used the old file, so it has to be
exported once.

1. Open the **old** HTML file in the same browser profile you used for it.
2. Open the browser console (F12) and run:
   ```js
   copy(localStorage.getItem('lj_store'))
   ```
3. Paste the clipboard into a file, for example `old-store.json`.
4. Stop the server if it is running, then run:
   ```bash
   node scripts/import-state.js old-store.json
   ```
5. Start the server with `npm start` and log in with your **old** admin password.
   If the old file had a password, it is imported; otherwise the current one is kept.

The import replaces the current data, so run it on a fresh install, or keep a copy
of `data/store.json` first.

## How the data is kept

- `data/store.json` holds everything: products and stock, orders, customers, coupons,
  offers, shop details, staff (hashed), notes and the activity log.
- Every write is saved to a temporary file and then renamed, so a crash cannot leave
  a half-written file.
- Each save increases a version number.

### Orders from customers

- Prices, coupon discounts and shipping are calculated by the server. Values sent by
  the browser for price or total are ignored.
- The server checks stock before accepting an order and rejects orders that exceed it.
- Phone numbers are matched exactly; a new phone creates a customer record.

### Admin saves and customer orders at the same time

The admin app keeps a copy of the data and sends it back when something changes.
If a customer orders while the admin's copy is out of date:

- the new customer order is kept and shown to the admin,
- stock is recalculated as "the admin's number minus the sales since that copy",
- an order the admin deleted in the meantime does not come back.

If the admin's copy is older than the sales log can account for (after about 5,000
sales), stock uses the lower of the two values, which avoids selling stock that
does not exist.

## API

Public (no login):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | The app. Data is included for the visitor: storefront only, or everything for a logged-in admin. |
| GET | `/api/public` | Storefront data: products, prices, stock, shop details, active coupons. |
| POST | `/api/orders` | Place an order. Body: `name, phone, address, email?, coupon?, method?, items: [{id, j, n}]` (`j` is the variant index). |
| GET | `/api/track?q=` | Find orders by order number or full phone number. Returns order summaries without phone or address. |
| POST | `/api/login` | Body `{password}`. Sets the session cookie. |
| POST | `/api/logout` | Ends the session. |

Admin (session cookie required):

| Method | Path | Purpose |
| --- | --- | --- |
| PUT | `/api/admin/state` | Save the whole admin state. Body `{state, baseVersion}`. Returns the saved state and `merged: true` if it was merged with newer orders. |

Rate limits (per IP): login 10 per 15 minutes, orders 30 per 10 minutes, tracking
120 per 10 minutes.

## Security notes

- Sessions are random tokens stored in memory, sent in an HttpOnly, SameSite=Strict
  cookie. Restarting the server logs everyone out.
- Admin saves must be JSON, which browsers do not send across sites without
  permission, and the cookie is SameSite=Strict.
- The customer page still contains the admin app's code (the single-file app design).
  The data is protected, the code is not. Do not put secrets in the code.
- Tracking by phone number reveals order summaries to anyone who knows the number.
  It is rate-limited. If this is a concern, remove the phone search from
  `lib/store.js` (`trackOrders`) and use order numbers only.

## Known limits

- The data file is suited to one shop with a few people working at once. Heavy use
  with many simultaneous writers would call for a real database (SQLite or Postgres).
- Changes made in the last half second before closing the admin tab may not be saved.
- The browser keeps a copy of the admin data while it is open, so two admin tabs
  open at once will merge their saves; this is safe but the later save wins for
  fields both tabs edited.

## Project layout

```
server.js               HTTP server, routes, per-visitor page data
lib/store.js            data file, orders, admin save merging, views
lib/security.js         password hashing, sessions, rate limiting
views/index.html        the app (single page: shop + admin)
seed/initial-state.json starting data (products, shop, coupon)
scripts/import-state.js import of an old browser export
data/                   created at runtime: store.json (back this up)
```

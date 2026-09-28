# Terram Farm — Butchery OS

One system for the butchery: every order enters once, is understood correctly, is validated, cut, packed, handed over and completed.

- **Internal app** (sign-in): Today, Orders, Cutting, Packing, Fulfilment, Customers, Products, Needs attention, Intelligence, Reports, Settings. Works on the butchery laptop, a tablet on the block and staff phones, and installs as an app (PWA).
- **Customer order form** at `/order` (public). It feeds the same order engine as everything else.

> **AI is the interpreter. The system is the source of truth.**
> Messages are read by a deterministic rules engine first. Claude is only asked about messages the rules can't fully understand. Whatever it proposes is re-checked against the product dictionary, quantity rules and the order state machine before anything is saved. When something is unclear the system doesn't guess: it asks a person in **Needs attention**.

**Going live?** Follow [LAUNCH.md](LAUNCH.md): deploy to Render, set a family code, and put it on every phone and computer.

---

## Quick start (local)

Requires Node 22+.

```bash
npm install
npm run build
npm start                       # http://localhost:8080 — first visit asks you to create the admin account
```

For development with hot reload: `npm run dev` (web on :5173, API on :8080).

To look around with realistic data: **Settings → Test mode → Load sample data**. Sample records are flagged and can be removed without touching real orders. `npm run seed:demo` loads the same data from the command line.

## Configuration

Copy `.env.example` to `.env`. Everything is optional except where noted.

| Variable | Purpose |
|---|---|
| `DATABASE_PATH` | SQLite file. Put it on a persistent disk/volume. Default `./data/terram.db` |
| `PORT` | HTTP port (default 8080) |
| `ANTHROPIC_API_KEY` | Enables the message assistant for messy messages. Without it, the rules engine still reads clear orders and everything else works |
| `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` | WhatsApp Business Cloud API webhook (see below) |
| `EMAIL_INBOUND_TOKEN` | Shared secret for the inbound-email webhook |
| `INITIAL_ADMIN_EMAIL`, `INITIAL_ADMIN_PASSWORD` | Create the first admin automatically on an empty database |
| `INSECURE_COOKIES=1` | Only for testing production mode over plain HTTP |

Business rules (collection/delivery days, lead time, whether online orders need review, the assistant model and effort, etc.) are in **Settings** in the app. Every change is recorded in the audit log.

## Brand kit and prices

Terram's brand kit ships with the app: the logo (`web/public/brand/`), Terram green `#446041`, charcoal `#303030` and white, and Montserrat headings (the closest open font to Garet). App icons are built with `node scripts/make-icons.mjs`. The product dictionary (`server/seed/catalogue.ts`) is Terram's Beef and Lamb price lists; an install that started on the old generic list is moved onto it automatically at startup (without touching products used by existing orders).

- **Settings → Branding:** upload a logo (PNG/JPG/WebP/SVG) and choose the brand colour. The app derives readable light and dark shades from it, and generates the Home Screen icon and the web-app manifest. Uploaded SVGs are served with a script-blocking security policy.
- **Products → Update prices:** paste a price list in any common format. Each line is matched with the same dictionary used for orders, shown as old → new, and applied only when confirmed (audited).

## Message formats

- `Name:` blocks, WhatsApp exports and pasted chats (names at the top).
- **Group-chat posts with the customer's name at the bottom** (optionally with a phone number). The name in the message wins over whoever posted it, and posts by team members are never treated as the customer.
- Direct messages without a name: choose the customer under **From** on the Paste orders screen.

## Signing in

- **Family code:** an admin sets one shared code (Settings → Team). On a new device you type the code and tap your name, and that device stays signed in for about six months. Only people an admin has allowed appear in the list. Guessing is rate-limited, and **Sign out other devices** revokes everything if a phone is lost.
- **Email and password:** for admins, or anyone without the family code.

## Deploying

A Render Blueprint (`render.yaml`) is included; [LAUNCH.md](LAUNCH.md) walks through it. The container fixes data-volume permissions at startup and then runs as the unprivileged `node` user. The server makes a nightly backup itself (kept on the data disk, newest 14), so no cron job is needed.

The app is one Node process plus one SQLite file, which suits a small business: no database server to run, and a backup is a single file.

**Docker** (any VPS, Fly.io, Railway, Render with a disk):

```bash
docker build -t terram-butchery .
docker run -d --name terram -p 8080:8080 -v terram-data:/data \
  -e ANTHROPIC_API_KEY=... terram-butchery
```

Put it behind HTTPS (Caddy, Nginx, or the platform's TLS). Session cookies are `Secure` in production.

Run a single instance (live updates between devices use an in-process event stream). If you ever need several instances, switch the database to Postgres and the event bus to Postgres `LISTEN/NOTIFY` — the domain code is written against small repository functions, so that is a contained change.

## Backups and your data

- **In the app:** Settings → Data & backup — download a full database backup, a complete JSON export, or CSVs (orders, items, customers, products, messages, audit log).
- **Scheduled:** `npm run backup` writes a consistent, integrity-checked copy to `data/backups/` and keeps the newest 30 (`BACKUP_DIR`, `BACKUP_KEEP`). Example cron: `15 2 * * * cd /app && npm run backup`. Copy the backups folder off the machine as well.
- **Restore:** stop the server, replace the database file with a backup (remove any `-wal`/`-shm` files next to it), start the server.
- **Locked out?** `npm run create-admin -- "Name" you@example.com 'new-password'` creates or resets an admin.

## Connecting WhatsApp Business

Personal WhatsApp accounts are never scraped. Until the Business API is connected, staff use **Paste WhatsApp** (single messages or an entire exported chat).

1. Create a Meta app with the WhatsApp product and a Business phone number.
2. Set `WHATSAPP_VERIFY_TOKEN` (any secret string) and `WHATSAPP_APP_SECRET` (from the Meta app) on the server.
3. Webhook URL: `https://<your-domain>/api/integrations/whatsapp/webhook`, verify token as above; subscribe to `messages`.

Incoming messages are signature-checked, stored raw, de-duplicated by WhatsApp message id (retries never create a second order), interpreted, and then:

- a new order becomes an order **To review**;
- a clear change to an order that is still under review is applied (and recorded);
- a change to a confirmed order becomes a one-tap **Possible amendment** in Needs attention;
- "Thanks!" and emojis are ignored;
- cancellations always need a person.

A suggested reply is prepared for each message that deserves one, and nothing is sent automatically. Staff send it with one tap from the order page, which opens WhatsApp with the text filled in.

## How an order flows

```
Order form ─┐
WhatsApp ───┤                         ┌─ clear → draft ready ─────────┐
Email ──────┼─► raw message stored ─► rules engine ─┤               ├─► central order engine ─► Confirmed
Phone/walk-in┤  (never destroyed)     └─ unclear → assistant (optional) → re-validated ┘        │
Paste/import ┘                                   anything uncertain → Needs attention (person)   ▼
                                     Cutting sheet ─► Packing ─► Ready ─► Collected / Delivered ─► Completed
```

Every change is an **order event** (before → after, who, when, and which message caused it), so "why did the system create this order?" is always answerable from the order's History and "Original message" panels.

### Workflow states

`To review → Confirmed → Cutting → Cut → Packing → Packed → Ready → (Out for delivery) → Completed`, plus `Needs clarification`, `On hold`, `Cancelled`. Only valid transitions are allowed (`shared/workflow.ts`). An order with an open blocking question can't be confirmed or cut. Changing an item after it was cut or packed sends the order back a step so nothing is missed. Cancelling and reopening need a manager.

### Roles

| Role | Can |
|---|---|
| Admin | Everything, including users, settings, backups and exports |
| Manager | Operations plus products, prices, cancellations, approvals, payment status |
| Staff | Orders, imports, exceptions, cutting, packing, fulfilment |
| View only | Read everything operational, change nothing |

Permissions are checked on the server for every request (`shared/permissions.ts`, `server/http/context.ts`).

## Project layout

```
shared/        Domain rules shared by server and web: workflow, permissions, quantities, text normalisation
server/
  db/          Schema + migrations (append-only), SQLite access
  domain/      Order engine, products, customers, exceptions & decisions, production, reports, search
  intelligence/  Terram Operations Intelligence:
                 splitter (chats → messages) · parser (message → items/intent) · matcher (words → products)
                 analyser (conversation context, amendments, references, contradictions) · drafts (validation)
                 ai (Claude adapter) · interpret (rules first, assistant second) · imports · inbound (live channels)
                 learning (observed → suggested → approved) · insights (workflow monitor, data quality, bottlenecks, health)
  http/, routes/ API, security middleware (auth, CSRF/origin checks, rate limits, idempotency keys)
  seed/        Product dictionary seed, Test Mode sample data
  scripts/     create-admin, backup, seed-demo
web/src/       React app (pages, components, print layouts, public order form)
tests/         Unit, pipeline, API/security and the 50-order acceptance test
scripts/       QA helpers: screenshots, overflow check, browser end-to-end run
```

## Testing

```bash
npm run typecheck
npm test               # 98 tests, including the 50-order acceptance test
```

The **50-order acceptance test** (`tests/acceptance-50.test.ts`) pastes a realistic chat with 50 orders, typos, varied wording, WhatsApp-export lines, amendments, additions, a vague "make those 2", a contradiction, unknown products, a double paste, a customer question, chatter and one of Terram's own replies. It then checks every order against ground truth, resolves the exceptions as staff would, and drives all orders through cutting, packing and fulfilment to completion.

Browser checks against a running build (`npm run build` first):

```bash
bash scripts/qa-server.sh               # throwaway server on :8092 with sample data
node scripts/e2e.mjs                    # customer form → import → exception → cutting → packing → handover
node scripts/screenshots.mjs            # every screen at desktop and phone width
node scripts/overflow.mjs /,/orders     # no horizontal scrolling on a 390px phone
```

## Security notes

- Passwords are hashed with scrypt; sessions are random tokens stored hashed, in `HttpOnly`, `SameSite=Lax` cookies.
- State-changing requests need a custom header and a same-origin `Origin` (CSRF protection). Webhooks authenticate with HMAC signatures or bearer tokens instead.
- All input is validated with schemas; SQL is parameterised; CSV exports neutralise spreadsheet formulas.
- Login, public form, imports and webhooks are rate-limited.
- API keys stay on the server. The assistant receives message text and the product list, and nothing else.
- Idempotency keys (UI and form) plus external message ids (webhooks) prevent duplicate orders from double clicks, refreshes, retries and resubmissions.

## Offline behaviour

The app shell is cached so it opens with a poor signal. It clearly shows **Offline**, and it never presents stale order data as current. Drafts of the customer form and of new orders are kept on the device until they are sent, and resending is always safe. Saving changes while offline is deliberately not supported yet. The service worker and idempotency keys are in place so it can be added later.

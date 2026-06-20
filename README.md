# El Club de la Pintura — Backend API

Node.js + Express REST API for the El Club de la Pintura ERP/POS system.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript |
| Framework | Express 5.x |
| ORM | Prisma 7.x (PostgreSQL) |
| Auth | HttpOnly JWT cookie + bcrypt |
| CSRF | csrf-csrf (double-submit cookie) |
| PDF | PDFKit |
| Excel | ExcelJS |
| Image upload | Cloudinary |
| Logger | Winston (dev: colorized, prod: JSON) |

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp env.example .env
# Edit .env with your values (see Environment Variables below)

# 3. Run database migrations
npx prisma migrate deploy

# 4. (Optional) Seed initial data
npx prisma db seed

# 5. Start development server
npm run dev        # ts-node-dev, port 4000
```

## Environment Variables

Copy `.env.example` to `.env` and fill in all required values:

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | HTTP port (default: `4000`) |
| `NODE_ENV` | No | `development` or `production` |
| `DATABASE_URL` | **Yes** | PostgreSQL connection string |
| `JWT_SECRET` | **Yes** | Stable, strong secret for JWT signing (64+ chars). **Never change without a planned logout of all users.** |
| `JWT_EXPIRES_IN` | No | Token lifetime (default: `8h`) |
| `FRONTEND_URL` | **Yes** | Origin allowed by CORS — comma-separated for multiple origins |
| `COOKIE_SAME_SITE` | No | `lax` (same-domain) or `none` (cross-origin, e.g. Vercel + Render). Default: `lax` |
| `ADMIN_EMAIL` | No | Initial admin email. **Required for first-deploy bootstrap.** No hardcoded default. |
| `ADMIN_PASSWORD` | No | Initial admin password. **Required for first-deploy bootstrap.** No hardcoded default. |
| `ADMIN_ONBOARD_SECRET` | No | Passphrase for creating additional ADMIN users via API |
| `CLOUDINARY_CLOUD_NAME` | **Yes** | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | **Yes** | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | **Yes** | Cloudinary API secret |

## Architecture

```
src/
├── app.ts                    # Express app setup (CORS, rate limiting, routes)
├── server.ts                 # HTTP server entry point
├── config/
│   ├── db.ts                 # Prisma client singleton
│   ├── logger.ts             # Winston logger (dev/prod formats)
│   └── cloudinary.ts         # Cloudinary SDK config
├── middlewares/
│   ├── auth.middleware.ts    # JWT verification + role injection
│   └── error.middleware.ts   # Global error handler
├── modules/                  # Feature modules (one directory per domain)
│   ├── auth/
│   ├── branch/
│   ├── cash-register/
│   ├── customer/
│   ├── dashboard/
│   ├── expense/
│   ├── finance/              # Legacy — prefer dashboard endpoints
│   ├── internal-receipt/
│   ├── payment/
│   ├── product/
│   ├── purchase/
│   ├── sale/
│   ├── stock/
│   ├── supplier/
│   ├── sync/                 # Offline-first sync (push/pull)
│   └── user/
└── utils/
    └── date.utils.ts         # parseLocalDate, localDayRange (UTC-3 safe)
```

Each module contains:
- `*.controller.ts` — request handling, validation, response shaping
- `*.routes.ts` — Express router with RBAC middleware
- `*.service.ts` — business logic shared across controllers (where applicable)

## Roles and Permissions

| Role | Access |
|------|--------|
| `ADMIN` | Full system access — all branches, all modules, user management |
| `ENCARGADO` | Branch-scoped — own branches only; cannot manage users |
| `EMPLOYEE` | POS, expenses, and cash register for assigned branches only |

## Authentication

Authentication uses **HttpOnly session cookies**, not Bearer tokens in the response body.

- **Login**: `POST /api/users/login` — sets a `club_token` HttpOnly cookie
- **Session restore**: `GET /api/users/me` — validates the cookie and returns the user profile
- **Logout**: `POST /api/users/logout` — clears the cookie

**CSRF protection** is implemented using the double-submit cookie pattern (`csrf-csrf`):
- The server issues an `XSRF-TOKEN` readable cookie on every GET request
- Axios (frontend) reads it automatically and sends it as `X-XSRF-TOKEN` on POST/PUT/PATCH/DELETE
- The server validates the header. Missing or invalid token → 403.
- `POST /api/users/login` and `POST /api/users/logout` are exempt (no session yet).

## Admin Bootstrap

There is **no hardcoded default admin credential**. To create the initial admin user:

1. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` environment variables before starting the server.
2. On first start, the server creates the admin user if it does not already exist.
3. On subsequent starts, if the user already exists, nothing changes (password is NOT overwritten).

## Key API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/users/login` | Authenticate, set HttpOnly cookie |
| `GET` | `/api/products` | Product catalog (paginated, with stock) |
| `POST` | `/api/sales` | Create sale (POS checkout) |
| `GET` | `/api/cash-registers/:branchId/active` | Active shift for a branch |
| `POST` | `/api/cash-registers/open` | Open a new shift |
| `PATCH` | `/api/cash-registers/:id/close` | Close a shift |
| `GET` | `/api/dashboard/summary` | KPI snapshot |
| `GET` | `/api/sync/pull` | Pull offline data snapshot |
| `POST` | `/api/sync/push` | Push queued offline operations |

## Date Handling (UTC-3 / Argentina)

All date-range queries use `parseLocalDate()` and `localDayRange()` from
`src/utils/date.utils.ts` instead of `new Date("YYYY-MM-DD")`.

Reason: ISO date-only strings are parsed as UTC midnight by the JS runtime.
On a UTC-3 server, `new Date("2026-05-26")` equals `2026-05-25T21:00:00` local —
the **previous** calendar day. The utility functions use `new Date(year, month-1, day)`
which always constructs in local time.

The frontend must send `YYYY-MM-DD` strings built with `getFullYear/getMonth/getDate`
(local getters), never `.toISOString().slice(0,10)` (UTC).

## Offline Sync

The `sync` module handles the offline-first POS workflow:

1. **Push** (`POST /api/sync/push`): the device sends operations queued in IndexedDB.
   Each is processed idempotently via `idempotencyKey`. Currently supported:
   `SALE_CREATE`, `EXPENSE_CREATE`.

2. **Pull** (`GET /api/sync/pull`): returns a full data snapshot (products, customers,
   active shift) so the POS can operate without internet.

3. **Status** (`GET /api/sync/status`): returns the operation queue state for the
   sync-status UI badge.

## AFIP Electronic Invoicing

**Status: Pending implementation.**

AFIP integration (WSFEv1) is stubbed. API routes exist but return `501 Not Implemented`.
Internal receipts are **not legal fiscal invoices**. Do not present them as such.

When AFIP is implemented, it will require: WSAA authentication, WSFEv1 invoice authorization,
CAE storage, sandbox/production separation, and certificate/private key management.

## Scripts

```bash
npm run dev         # Development server with hot reload
npm run build       # Compile TypeScript to dist/
npm run start       # Production server (from dist/)
npm test            # Run Jest integration suite (needs TEST_DATABASE_URL)
npx prisma studio   # Visual database browser
npx prisma migrate deploy  # Apply all pending migrations (required before start in production)
npx prisma migrate dev --name <name>  # Create a new migration (development only)
./scripts/backup-db.sh     # Compressed pg_dump backup (bridge until managed backups)
```

## Testing & CI

The Jest suite (`tests/`) runs **integration tests against a real Postgres**.
A safety guard (`tests/helpers/setup.ts`) refuses to run unless `TEST_DATABASE_URL`
is set, so it never touches the production database. Run locally with a throwaway
DB:

```bash
TEST_DATABASE_URL=postgres://localhost:5432/el_club_test npm test
```

**CI** (`.github/workflows/ci.yml`) runs on every push/PR to `main`: it spins up an
ephemeral Postgres service, runs `prisma generate` → `tsc --noEmit` →
`prisma db push` → `npm test`. A red pipeline blocks the change. The frontend's
Playwright e2e covers the UI side; the two meet at the API contract.

## Database Migrations

Schema changes are managed exclusively through Prisma migrations. **Never use `prisma db push` in production.**

Before starting the server for the first time (or after a deploy):
```bash
npx prisma migrate deploy
```

Current migration history:
- `00000000000000_baseline` — Initial full schema
- `20260529000000_add_payroll_tables` — Employee and PayrollRecord models
- `20260605000000_float_to_decimal_financial_fields` — Financial precision upgrade
- `20260605120000_add_customer_credit_fields` — Customer creditLimit and defaultDiscount
- `20260605130000_add_stock_indexes_and_constraints` — Stock non-negative constraint + report indexes
- `20260605140000_add_bulk_price_job` — Persistent bulk price update job tracking

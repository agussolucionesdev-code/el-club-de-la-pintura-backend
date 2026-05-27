# El Club de la Pintura — Backend API

Node.js + Express REST API for the El Club de la Pintura ERP/POS system.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript |
| Framework | Express 4 |
| ORM | Prisma 5 (PostgreSQL) |
| Auth | JWT (`jsonwebtoken`) + bcrypt |
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
| `JWT_SECRET` | **Yes** | Long random string for JWT signing |
| `JWT_EXPIRES_IN` | No | Token lifetime (default: `8h`) |
| `FRONTEND_URL` | **Yes** | Origin allowed by CORS (e.g. `http://localhost:5174`) |
| `CLOUDINARY_CLOUD_NAME` | **Yes** | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | **Yes** | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | **Yes** | Cloudinary API secret |
| `ADMIN_ONBOARD_SECRET` | No | Passphrase for the initial admin bootstrap endpoint |

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

## Key API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/users/login` | Authenticate, receive JWT |
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

## Scripts

```bash
npm run dev         # Development server with hot reload
npm run build       # Compile TypeScript to dist/
npm run start       # Production server (from dist/)
npx prisma studio   # Visual database browser
npx prisma migrate dev --name <name>  # Create a new migration
```

// Automatic loading of environment variables (top priority at startup)
import { logger } from './config/logger';
import "dotenv/config";
import { execSync } from "node:child_process";

// Core modules and utilities
import express, { Application, Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import helmet from "helmet";

// Global security middlewares
import {
  globalErrorHandler,
  notFoundHandler,
} from "./middlewares/error.middleware";
import { serializeDecimals } from "./middlewares/serialize.middleware";
import { csrfProtection, attachCsrfToken } from "./middlewares/csrf.middleware";

// Modular routers (feature-first architecture)
import branchRoutes from "./modules/branch/branch.routes";
import productRoutes from "./modules/product/product.routes";
import userRoutes from "./modules/user/user.routes";
import stockRoutes from "./modules/stock/stock.routes";
import saleRoutes from "./modules/sale/sale.routes";
import financeRoutes from "./modules/finance/finance.routes";
import customerRoutes from "./modules/customer/customer.routes";
import paymentRoutes from "./modules/payment/payment.routes";
import supplierRoutes from "./modules/supplier/supplier.routes";
import cashRegisterRoutes from "./modules/cash-register/cash-register.routes";
import expenseRoutes from "./modules/expense/expense.routes";
import dashboardRoutes from "./modules/dashboard/dashboard.routes";
import syncRoutes from "./modules/sync/sync.routes";
import purchaseRoutes from "./modules/purchase/purchase.routes";
import internalReceiptRoutes from "./modules/internal-receipt/internal-receipt.routes";
import auditLogRoutes from "./modules/audit-log/audit-log.routes";
import payrollRoutes from "./modules/payroll/payroll.routes";
import returnRoutes from "./modules/return/return.routes";
import afipRoutes from "./modules/afip/afip.routes";
import alertsRoutes from "./modules/alerts/alerts.routes";
import settingsRoutes from "./modules/settings/settings.routes";

// Express app initialization
const app: Application = express();
const PORT = process.env.PORT || 4000;

// Global rate limiter — 300 requests per minute per IP across all routes
// (login has its own tighter limiter defined in user.routes.ts)
const globalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Esperá un momento e intentá de nuevo." },
});

// ============================================================================
// 1. REQUEST PROCESSING AND SECURITY MIDDLEWARES
// ============================================================================

// Security headers (X-Content-Type-Options, X-Frame-Options, HSTS in prod, ...).
// This is a JSON + PDF API consumed by a cross-origin SPA (Vercel → Render):
//   - contentSecurityPolicy off: CSP targets HTML documents, not a JSON/PDF API.
//   - crossOriginResourcePolicy "cross-origin": let the SPA read API/PDF responses.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

// Restrict cross-origin requests to the configured frontend origin only.
// Wildcard CORS is disabled in all environments to prevent unauthorized API access.
app.use(
  cors({
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(",").map((o) => o.trim())
      : ["http://localhost:5173", "http://localhost:5174"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Expose X-CSRF-Token so cross-origin JS (Vercel → Render) can read it.
    // Without this, the browser hides the header and _csrfToken stays null.
    exposedHeaders: ["X-CSRF-Token"],
  }),
);

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));
app.use(serializeDecimals);
app.use("/api", globalRateLimiter);

// ============================================================================
// 2. CSRF SETUP
// ============================================================================
// The XSRF-TOKEN cookie (readable by JS) is issued on every GET request so
// Axios always has a fresh token before any state-changing request is made.
// POST /PUT /PATCH /DELETE must carry X-XSRF-TOKEN matching the cookie.
//
// Exempt routes:
//   POST /api/users/login  — no session cookie exists yet; GET /api/users/me
//                            always fires first (AuthContext), setting the token
//   POST /api/users/logout — clearing cookies; nothing sensitive to protect

// Issue/refresh XSRF-TOKEN cookie on every GET so Axios always has a fresh one
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "GET") attachCsrfToken(req, res);
  next();
});

// CSRF protection: validate X-XSRF-TOKEN on all mutating requests except the
// two routes listed below (login has no prior token; logout is idempotent).
const CSRF_EXEMPT = new Set([
  "/api/users/login",
  "/api/users/logout",
]);

app.use((req: Request, res: Response, next: NextFunction) => {
  // Skip CSRF in the test environment — supertest does not manage cookies
  if (process.env.NODE_ENV === "test") return next();
  if (CSRF_EXEMPT.has(req.path)) return next();
  csrfProtection(req, res, next);
});

// ============================================================================
// 3. DIAGNOSTIC ENDPOINTS (registered after CSRF so GET /api/health also
//    issues the XSRF-TOKEN cookie for uptime monitors / initial page loads)
// ============================================================================
app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "success",
    message: `Backend running in ${process.env.NODE_ENV || "development"} mode`,
  });
});

// ============================================================================
// 4. BUSINESS ROUTES (REST API)
// ============================================================================
app.use("/api/branches", branchRoutes);
app.use("/api/products", productRoutes);
app.use("/api/users", userRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/sales", saleRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/cash-registers", cashRegisterRoutes);
app.use("/api/expenses", expenseRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/sync", syncRoutes);
app.use("/api/purchases", purchaseRoutes);
app.use("/api/internal-receipts", internalReceiptRoutes);
app.use("/api/audit-logs", auditLogRoutes);
app.use("/api/payroll", payrollRoutes);
app.use("/api/sales", returnRoutes);
app.use("/api/afip", afipRoutes);
app.use("/api/alerts", alertsRoutes);
app.use("/api/settings", settingsRoutes);

// ============================================================================
// 4. ERROR HANDLERS — must be registered after all routes
// ============================================================================
app.use(notFoundHandler);
app.use(globalErrorHandler);

// ============================================================================
// 5. SERVER STARTUP
// ============================================================================

/**
 * One-time admin bootstrap: creates the initial admin user when the DB is
 * empty. Requires ADMIN_EMAIL and ADMIN_PASSWORD env vars to be explicitly
 * set. If either is missing, bootstrap is skipped and a warning is logged —
 * no hardcoded credentials exist in production.
 *
 * This function is idempotent: if the admin already exists it does nothing.
 * It does NOT overwrite the password on subsequent restarts.
 */
async function bootstrapAdminIfNeeded(): Promise<void> {
  const email    = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name     = process.env.ADMIN_NAME || "Administrador";

  if (!email || !password) {
    logger.warn(
      "[STARTUP] ADMIN_EMAIL or ADMIN_PASSWORD not set — skipping admin bootstrap. " +
      "Set both env vars to create the initial admin user."
    );
    return;
  }

  const { default: prisma } = await import("./config/db");
  const bcrypt = await import("bcrypt");

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      logger.info(`[STARTUP] Admin user already exists: ${email} — no changes made.`);
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    let branch = await prisma.branch.findFirst({ orderBy: { id: "asc" } });
    if (!branch) {
      branch = await prisma.branch.create({
        data: { name: "Casa Central", location: "Principal" },
      });
      logger.info("[STARTUP] Created default branch: Casa Central");
    }

    await prisma.user.create({
      data: {
        email,
        name,
        role: "ADMIN",
        password: passwordHash,
        branches: { connect: [{ id: branch.id }] },
      },
    });

    logger.info(`[STARTUP] Admin user created: ${email}`);
  } catch (err) {
    logger.error("[STARTUP] Failed to bootstrap admin user:", err);
  }
}

/**
 * Apply pending Prisma migrations at boot, BEFORE serving traffic.
 *
 * The hosting dashboard's build command overrides render.yaml, so
 * `prisma migrate deploy` never runs during builds — the root cause of every
 * "column does not exist" incident on this host. Running it here guarantees
 * each release ships its schema changes, no matter how the build is configured.
 */
function applyMigrationsAtBoot(): void {
  try {
    execSync("npx prisma migrate deploy", { stdio: "inherit", timeout: 180_000 });
    logger.info("[STARTUP] prisma migrate deploy: schema up to date.");
  } catch (err) {
    // Keep serving with the previous schema rather than crash-looping;
    // the log line is the signal to investigate.
    logger.error("[STARTUP] prisma migrate deploy failed:", err);
  }
}

/**
 * Belt-and-suspenders: guarantee the CashMovement table exists even if
 * `migrate deploy` was skipped by the host. Idempotent raw DDL, mirrors the
 * migration. This host has a history of migrations not applying at build time.
 */
async function ensureCashMovementTable(): Promise<void> {
  try {
    const { default: prisma } = await import("./config/db");
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CashMovement" (
        "id" SERIAL NOT NULL,
        "type" TEXT NOT NULL,
        "amount" DECIMAL(14,2) NOT NULL,
        "reason" TEXT NOT NULL,
        "cashRegisterId" INTEGER NOT NULL,
        "userId" INTEGER NOT NULL,
        "branchId" INTEGER NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "CashMovement_cashRegisterId_idx" ON "CashMovement"("cashRegisterId");`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "CashMovement_branchId_createdAt_idx" ON "CashMovement"("branchId", "createdAt");`,
    );
    logger.info("[STARTUP] CashMovement table ensured.");
  } catch (err) {
    logger.error("[STARTUP] ensureCashMovementTable failed:", err);
  }
}

/**
 * Belt-and-suspenders for the profile photo column, same reasoning as
 * `ensureCashMovementTable`: additive, idempotent, safe to run every boot.
 */
async function ensureUserAvatarColumn(): Promise<void> {
  try {
    const { default: prisma } = await import("./config/db");
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;`,
    );
    logger.info("[STARTUP] User.avatarUrl column ensured.");
  } catch (err) {
    logger.error("[STARTUP] ensureUserAvatarColumn failed:", err);
  }
}

/** Same belt-and-suspenders for the "Sano desde" threshold. */
async function ensureHealthyStockColumn(): Promise<void> {
  try {
    const { default: prisma } = await import("./config/db");
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "Stock" ADD COLUMN IF NOT EXISTS "healthyStock" INTEGER NOT NULL DEFAULT 0;`,
    );
    logger.info("[STARTUP] Stock.healthyStock column ensured.");
  } catch (err) {
    logger.error("[STARTUP] ensureHealthyStockColumn failed:", err);
  }
}

/**
 * Belt-and-suspenders for the settings table, same reasoning as the two above.
 * Seeds the single row so the first read never races to create it.
 */
async function ensureAppSettingTable(): Promise<void> {
  try {
    const { default: prisma } = await import("./config/db");
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "AppSetting" (
        "id" INTEGER NOT NULL DEFAULT 1,
        "discountCodeVisibleToEncargado" BOOLEAN NOT NULL DEFAULT true,
        "alertCashEnabled" BOOLEAN NOT NULL DEFAULT true,
        "alertStockEnabled" BOOLEAN NOT NULL DEFAULT true,
        "alertStockMinCount" INTEGER NOT NULL DEFAULT 1,
        "alertAccountsEnabled" BOOLEAN NOT NULL DEFAULT true,
        "alertAccountsMinDebt" INTEGER NOT NULL DEFAULT 0,
        "alertPayrollEnabled" BOOLEAN NOT NULL DEFAULT true,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AppSetting" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;`,
    );
    // Added after the table's first ship; older DBs won't have it yet.
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "AppSetting" ADD COLUMN IF NOT EXISTS "discountCodeMode" TEXT NOT NULL DEFAULT 'DAILY';`,
    );
    logger.info("[STARTUP] AppSetting table ensured.");
  } catch (err) {
    logger.error("[STARTUP] ensureAppSettingTable failed:", err);
  }
}

/** Single-use discount codes for PER_SALE mode. */
async function ensureDiscountTokenTable(): Promise<void> {
  try {
    const { default: prisma } = await import("./config/db");
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DiscountToken" (
        "id" SERIAL NOT NULL,
        "code" TEXT NOT NULL,
        "branchId" INTEGER NOT NULL,
        "used" BOOLEAN NOT NULL DEFAULT false,
        "createdBy" INTEGER NOT NULL,
        "expiresAt" TIMESTAMP(3) NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "DiscountToken_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(
      `CREATE INDEX IF NOT EXISTS "DiscountToken_branchId_code_idx" ON "DiscountToken"("branchId", "code");`,
    );
    logger.info("[STARTUP] DiscountToken table ensured.");
  } catch (err) {
    logger.error("[STARTUP] ensureDiscountTokenTable failed:", err);
  }
}

if (process.env.NODE_ENV !== "test") {
  const portNumber = typeof PORT === "string" ? parseInt(PORT, 10) : PORT;

  applyMigrationsAtBoot();
  void ensureCashMovementTable();
  void ensureUserAvatarColumn();
  void ensureHealthyStockColumn();
  void ensureAppSettingTable();
  void ensureDiscountTokenTable();

  const server = app.listen(portNumber, "0.0.0.0", async () => {
    logger.info(`Server running on http://127.0.0.1:${portNumber}`);
    await bootstrapAdminIfNeeded();
  });

  // Graceful shutdown: stop accepting new connections, drain in-flight
  // requests, then close the DB pool. Render sends SIGTERM on deploy/restart.
  const shutdown = (signal: string) => {
    logger.info(`[SHUTDOWN] ${signal} received — draining connections...`);
    server.close(async () => {
      try {
        const { default: prisma } = await import("./config/db");
        await prisma.$disconnect();
      } catch (err) {
        logger.error("[SHUTDOWN] Error disconnecting Prisma:", err);
      }
      logger.info("[SHUTDOWN] Closed cleanly.");
      process.exit(0);
    });
    // Safety net: force-exit if draining hangs.
    setTimeout(() => {
      logger.error("[SHUTDOWN] Forced exit after 10s drain timeout.");
      process.exit(1);
    }, 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Last-resort handlers: log stray async errors instead of crashing silently
// or leaving the process in an inconsistent state.
process.on("unhandledRejection", (reason) => {
  logger.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  logger.error("[UNCAUGHT EXCEPTION]", err);
});

export default app;

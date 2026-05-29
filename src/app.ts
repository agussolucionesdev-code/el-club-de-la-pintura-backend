// Automatic loading of environment variables (top priority at startup)
import { logger } from './config/logger';
import "dotenv/config";

// Core modules and utilities
import express, { Application, Request, Response } from "express";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

// Global security middlewares
import {
  globalErrorHandler,
  notFoundHandler,
} from "./middlewares/error.middleware";

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

// Express app initialization
const app: Application = express();
const PORT = process.env.PORT || 4000;

// ============================================================================
// 1. REQUEST PROCESSING AND SECURITY MIDDLEWARES
// ============================================================================

// Restrict cross-origin requests to the configured frontend origin only.
// Wildcard CORS is disabled in all environments to prevent unauthorized API access.
app.use(
  cors({
    origin: process.env.FRONTEND_URL
      ? process.env.FRONTEND_URL.split(",").map((o) => o.trim())
      : ["http://localhost:5173", "http://localhost:5174"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

// ============================================================================
// 2. DIAGNOSTIC ENDPOINTS
// ============================================================================
app.get("/api/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "success",
    message: `Backend running in ${process.env.NODE_ENV || "development"} mode`,
  });
});

// ============================================================================
// 3. BUSINESS ROUTES (REST API)
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

// ============================================================================
// 4. ERROR HANDLERS — must be registered after all routes
// ============================================================================
app.use(notFoundHandler);
app.use(globalErrorHandler);

// ============================================================================
// 5. SERVER STARTUP
// ============================================================================

/**
 * Ensures a default admin user exists in the database on every startup.
 * Uses the ADMIN_EMAIL / ADMIN_PASSWORD env vars (falls back to dev defaults).
 * This is an idempotent upsert — safe to run on every boot.
 * Prevents the "no admin user in production" problem after fresh deploys.
 */
async function ensureAdminUser(): Promise<void> {
  const { default: prisma } = await import("./config/db");
  const bcrypt = await import("bcrypt");

  const email    = process.env.ADMIN_EMAIL    || "admin@clubpintura.local";
  const password = process.env.ADMIN_PASSWORD || process.env.SEED_DEFAULT_PASSWORD || "ClubPintura2026!";
  const name     = process.env.ADMIN_NAME     || "Administrador";

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      logger.info(`Admin user already exists: ${email}`);
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Ensure at least one branch exists
    let branch = await prisma.branch.findFirst({ orderBy: { id: "asc" } });
    if (!branch) {
      branch = await prisma.branch.create({
        data: { name: "Casa Central", location: "Principal" },
      });
      logger.info("Created default branch: Casa Central");
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

    logger.info(`Admin user created: ${email}`);
  } catch (err) {
    // Non-fatal — log and continue. The app should still start.
    logger.error("Failed to ensure admin user on startup:", err);
  }
}

/**
 * Ensures payroll tables exist using raw SQL (CREATE TABLE IF NOT EXISTS).
 * This bypasses Prisma migrate entirely — safe to run on every boot.
 * Required because the original baseline migration predates payroll models.
 */
async function ensurePayrollTables(): Promise<void> {
  const { default: prisma } = await import("./config/db");
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Employee" (
        "id"         SERIAL        NOT NULL,
        "userId"     INTEGER       NOT NULL,
        "position"   TEXT          NOT NULL,
        "salaryType" TEXT          NOT NULL DEFAULT 'FIXED',
        "baseSalary" DECIMAL(12,2) NOT NULL,
        "branchId"   INTEGER       NOT NULL,
        "isActive"   BOOLEAN       NOT NULL DEFAULT true,
        "createdAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt"  TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "Employee_userId_key" ON "Employee"("userId");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "Employee_branchId_idx" ON "Employee"("branchId");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "PayrollRecord" (
        "id"           SERIAL        NOT NULL,
        "employeeId"   INTEGER       NOT NULL,
        "period"       TEXT          NOT NULL,
        "baseSalary"   DECIMAL(12,2) NOT NULL,
        "advances"     DECIMAL(12,2) NOT NULL DEFAULT 0,
        "bonuses"      DECIMAL(12,2) NOT NULL DEFAULT 0,
        "deductions"   DECIMAL(12,2) NOT NULL DEFAULT 0,
        "netPay"       DECIMAL(12,2) NOT NULL,
        "status"       TEXT          NOT NULL DEFAULT 'PENDING',
        "paidAt"       TIMESTAMP(3),
        "observations" TEXT,
        "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PayrollRecord_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'PayrollRecord_employeeId_fkey'
        ) THEN
          ALTER TABLE "PayrollRecord"
            ADD CONSTRAINT "PayrollRecord_employeeId_fkey"
            FOREIGN KEY ("employeeId") REFERENCES "Employee"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
        END IF;
      END $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "PayrollRecord_employeeId_period_key"
        ON "PayrollRecord"("employeeId", "period");
    `);
    logger.info("Payroll tables ready");
  } catch (err) {
    logger.error("Failed to ensure payroll tables on startup:", err);
  }
}

if (process.env.NODE_ENV !== "test") {
  const portNumber = typeof PORT === "string" ? parseInt(PORT, 10) : PORT;

  app.listen(portNumber, "0.0.0.0", async () => {
    logger.info(`Server running on http://127.0.0.1:${portNumber}`);
    await ensurePayrollTables();
    await ensureAdminUser();
  });
}

export default app;

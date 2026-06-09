// Automatic loading of environment variables (top priority at startup)
import { logger } from './config/logger';
import "dotenv/config";

// Core modules and utilities
import express, { Application, Request, Response, NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

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
app.use(morgan("dev"));
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

if (process.env.NODE_ENV !== "test") {
  const portNumber = typeof PORT === "string" ? parseInt(PORT, 10) : PORT;

  app.listen(portNumber, "0.0.0.0", async () => {
    logger.info(`Server running on http://127.0.0.1:${portNumber}`);
    await bootstrapAdminIfNeeded();
  });
}

export default app;

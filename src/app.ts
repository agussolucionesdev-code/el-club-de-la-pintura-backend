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
if (process.env.NODE_ENV !== "test") {
  const portNumber = typeof PORT === "string" ? parseInt(PORT, 10) : PORT;

  app.listen(portNumber, "0.0.0.0", () => {
    logger.info(`Server running on http://127.0.0.1:${portNumber}`);
  });
}

export default app;

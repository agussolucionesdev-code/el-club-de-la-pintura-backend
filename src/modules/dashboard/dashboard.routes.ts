import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { dashboardFilterSchema } from "../../schemas/dashboard.schema";
import {
  getFinancialSummary,
  getExpensesAnalytics,
  getProductsAnalytics,
  getCreditRiskAnalytics,
  exportFinancialReportToExcel,
  getDashboardSummary,
} from "./dashboard.controller";

const router = Router();

router.use(authenticateToken);

router.get("/summary", authorizeRoles("ADMIN", "ENCARGADO"), getDashboardSummary);
router.get(
  "/finance",
  authorizeRoles("ADMIN"),
  validate(dashboardFilterSchema),
  getFinancialSummary,
);
router.get(
  "/expenses",
  authorizeRoles("ADMIN"),
  validate(dashboardFilterSchema),
  getExpensesAnalytics,
);
router.get(
  "/products",
  authorizeRoles("ADMIN"),
  validate(dashboardFilterSchema),
  getProductsAnalytics,
);
router.get(
  "/credit-risk",
  authorizeRoles("ADMIN"),
  validate(dashboardFilterSchema),
  getCreditRiskAnalytics,
);
router.get("/export", authorizeRoles("ADMIN"), exportFinancialReportToExcel);

export default router;

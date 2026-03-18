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
} from "./dashboard.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN"));

router.get("/finance", validate(dashboardFilterSchema), getFinancialSummary);
router.get("/expenses", validate(dashboardFilterSchema), getExpensesAnalytics);
router.get("/products", validate(dashboardFilterSchema), getProductsAnalytics);
router.get(
  "/credit-risk",
  validate(dashboardFilterSchema),
  getCreditRiskAnalytics,
);
router.get("/export", exportFinancialReportToExcel);

export default router;

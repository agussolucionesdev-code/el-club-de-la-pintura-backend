import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { dashboardFilterSchema } from "../../schemas/dashboard.schema";
import {
  getFinancialSummary,
  getExpensesAnalytics,
  getProductsAnalytics,
} from "./dashboard.controller";

const router = Router();

router.use(verifyToken, authorizeRoles("ADMIN"));

router.get(
  "/finance",
  validateSchema(dashboardFilterSchema),
  getFinancialSummary,
);
router.get(
  "/expenses",
  validateSchema(dashboardFilterSchema),
  getExpensesAnalytics,
);

// NUEVO: Motor Analítico Logístico
router.get(
  "/products",
  validateSchema(dashboardFilterSchema),
  getProductsAnalytics,
);

export default router;

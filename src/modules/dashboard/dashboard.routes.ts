import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { dashboardFilterSchema } from "../../schemas/dashboard.schema";
import {
  getFinancialSummary,
  getExpensesAnalytics,
  getProductsAnalytics,
  getCreditRiskAnalytics,
  exportFinancialReportToExcel, // <-- IMPORTACIÓN DEL EXPORTADOR
} from "./dashboard.controller";

const router = Router();

// BÓVEDA GERENCIAL: Solo los dueños (ADMIN) pueden ver los números del negocio.
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
router.get(
  "/products",
  validateSchema(dashboardFilterSchema),
  getProductsAnalytics,
);
router.get(
  "/credit-risk",
  validateSchema(dashboardFilterSchema),
  getCreditRiskAnalytics,
);

// NUEVO: Ruta para que el contador descargue el Excel
router.get("/export", exportFinancialReportToExcel);

export default router;

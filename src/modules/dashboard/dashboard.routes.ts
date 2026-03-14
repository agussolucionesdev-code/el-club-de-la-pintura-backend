import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { dashboardFilterSchema } from "../../schemas/dashboard.schema";
import {
  getFinancialSummary, // BÓVEDA FINANCIERA
  getExpensesAnalytics, // NUEVO: Motor Financiero
  getProductsAnalytics, // NUEVO: Motor Analítico Logístico
  getCreditRiskAnalytics, // NUEVO: Ruta conectada para el Muro de Deudores y Riesgo Crediticio
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

// NUEVO: Ruta conectada para el Muro de Deudores y Riesgo Crediticio
router.get(
  "/credit-risk",
  validateSchema(dashboardFilterSchema),
  getCreditRiskAnalytics,
);

export default router;

import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import {
  registerAccountPayment, // El nuevo motor financiero Poka-Yoke
  registerDebtCollection, // Tu función original intacta
  generatePrintableReceipt, // Tu PDF de backend intacto
} from "./payment.controller";

const router = Router();

// ============================================================================
// RUTAS FINANCIERAS Y DE COBRANZA
// ============================================================================

// 1. NUEVO COBRO B2B: Integra saldo de cuenta corriente (Usado por el nuevo Modal del Frontend)
router.post(
  "/account",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"), // Mantenemos tu blindaje de seguridad
  registerAccountPayment,
);

// 2. COBRO CLÁSICO: Tu ruta original (No eliminamos nada)
router.post(
  "/",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  registerDebtCollection,
);

// 3. RECIBO PDF BACKEND: Mantenemos tu funcionalidad original de impresión
router.get(
  "/:paymentId/receipt/pdf",
  authenticateToken,
  generatePrintableReceipt,
);

export default router;

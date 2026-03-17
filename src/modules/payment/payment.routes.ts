import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import {
  registerDebtCollection,
  generatePrintableReceipt,
} from "./payment.controller";

const router = Router();

// ============================================================================
// COBRANZA DE DEUDAS (Cuentas Corrientes)
// Seguridad: Solo dueños y encargados autorizados
// ============================================================================
router.post(
  "/",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  registerDebtCollection,
);

// ============================================================================
// EMISIÓN DE COMPROBANTES PDF
// ============================================================================
router.get("/:paymentId/receipt/pdf", verifyToken, generatePrintableReceipt);

export default router;

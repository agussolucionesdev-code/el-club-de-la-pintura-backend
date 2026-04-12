import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import {
  registerAccountPayment,
  registerDebtCollection,
  generatePrintableReceipt,
} from "./payment.controller";

const router = Router();

router.post(
  "/account",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  registerAccountPayment,
);

router.post(
  "/",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  registerDebtCollection,
);

router.get(
  "/:paymentId/receipt/pdf",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  generatePrintableReceipt,
);

export default router;

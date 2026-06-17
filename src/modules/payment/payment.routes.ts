import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { registerAccountPaymentSchema } from "../../schemas/payment.schema";
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
  validate(registerAccountPaymentSchema),
  registerAccountPayment,
);

router.post(
  "/",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validate(registerAccountPaymentSchema),
  registerDebtCollection,
);

router.get(
  "/:paymentId/receipt/pdf",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  generatePrintableReceipt,
);

export default router;

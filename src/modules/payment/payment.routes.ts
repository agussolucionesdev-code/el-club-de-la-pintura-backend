import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import {
  registerDebtCollection,
  generatePrintableReceipt,
} from "./payment.controller";

const router = Router();

router.post(
  "/",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  registerDebtCollection,
);

router.get(
  "/:paymentId/receipt/pdf",
  authenticateToken,
  generatePrintableReceipt,
);

export default router;

import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeBranchAccess } from "../../middlewares/branch.middleware";
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
  authorizeBranchAccess(),
  registerAccountPayment,
);

router.post(
  "/",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  authorizeBranchAccess(),
  registerDebtCollection,
);

router.get(
  "/:paymentId/receipt/pdf",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  generatePrintableReceipt,
);

export default router;

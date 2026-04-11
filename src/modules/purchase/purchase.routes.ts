import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import {
  createPurchaseOrder,
  receivePurchaseReceipt,
} from "./purchase.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO"));

router.post("/orders", createPurchaseOrder);
router.post("/receipts", receivePurchaseReceipt);

export default router;

import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import {
  createPurchaseOrder,
  getPurchaseOrders,
  getPurchaseReceipts,
  receivePurchaseReceipt,
} from "./purchase.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO"));

router.get("/orders", getPurchaseOrders);
router.post("/orders", createPurchaseOrder);
router.get("/receipts", getPurchaseReceipts);
router.post("/receipts", receivePurchaseReceipt);

export default router;

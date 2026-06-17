import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  createPurchaseOrderSchema,
  receivePurchaseReceiptSchema,
} from "../../schemas/purchase.schema";
import {
  createPurchaseOrder,
  getPurchaseOrders,
  getPurchaseReceipts,
  receivePurchaseReceipt,
} from "./purchase.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO"));

router.get("/orders", getPurchaseOrders);
router.post("/orders", validate(createPurchaseOrderSchema), createPurchaseOrder);
router.get("/receipts", getPurchaseReceipts);
router.post("/receipts", validate(receivePurchaseReceiptSchema), receivePurchaseReceipt);

export default router;

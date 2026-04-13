import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import {
  generateInternalReceiptPdf,
  getInternalReceiptById,
  getInternalReceipts,
} from "./internal-receipt.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"));

router.get("/", getInternalReceipts);
router.get("/:id/pdf", generateInternalReceiptPdf);
router.get("/:id", getInternalReceiptById);

export default router;

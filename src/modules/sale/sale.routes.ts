import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeBranchAccess } from "../../middlewares/branch.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createSaleSchema } from "../../schemas/sale.schema";
import {
  getSales,
  getSaleById,
  createSale,
  getPendingAccounts,
  exportPendingAccountsExcel,
  generateSaleReceiptPdf,
  cancelSale,
} from "./sale.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"));

router.get(
  "/pending/:branchId",
  authorizeBranchAccess({ allowAllBranches: true }),
  getPendingAccounts,
);
router.get(
  "/pending-export/excel",
  authorizeRoles("ADMIN", "ENCARGADO"),
  exportPendingAccountsExcel,
);
router.get("/", getSales);
router.get("/:id/receipt/pdf", generateSaleReceiptPdf);
router.post("/:id/cancel", authorizeRoles("ADMIN", "ENCARGADO"), cancelSale);
router.get("/:id", getSaleById);
router.post("/", authorizeBranchAccess(), validate(createSaleSchema), createSale);

export default router;

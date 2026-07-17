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
  getDiscountCode,
  generateDiscountCode,
  validateDiscountCode,
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
// Ticket-discount authorization code — registered BEFORE "/:id" so the
// literal path never gets swallowed by the param route.
router.get("/discount-code", authorizeRoles("ADMIN", "ENCARGADO"), getDiscountCode);
router.post("/discount-code/generate", authorizeRoles("ADMIN", "ENCARGADO"), generateDiscountCode);
router.post("/discount-code/validate", validateDiscountCode);

router.get("/", getSales);
router.get("/:id/receipt/pdf", generateSaleReceiptPdf);
router.post("/:id/cancel", authorizeRoles("ADMIN", "ENCARGADO"), cancelSale);
router.get("/:id", getSaleById);
router.post("/", authorizeBranchAccess(), validate(createSaleSchema), createSale);

export default router;

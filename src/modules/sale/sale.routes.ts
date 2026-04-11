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
} from "./sale.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"));

router.get(
  "/pending/:branchId",
  authorizeBranchAccess({ allowAllBranches: true }),
  getPendingAccounts,
);
router.get("/", getSales);
router.get("/:id", getSaleById);
router.post("/", authorizeBranchAccess(), validate(createSaleSchema), createSale);

export default router;

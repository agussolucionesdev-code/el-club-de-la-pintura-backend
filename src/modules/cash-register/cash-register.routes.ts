import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeBranchAccess } from "../../middlewares/branch.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import {
  getActiveShift,
  openShift,
  closeShift,
} from "./cash-register.controller";

const router = Router();

router.use(authenticateToken);

router.get(
  "/:branchId/active",
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  authorizeBranchAccess(),
  getActiveShift,
);
router.post(
  "/open",
  authorizeRoles("ADMIN", "ENCARGADO"),
  authorizeBranchAccess(),
  openShift,
);
router.post("/:id/close", authorizeRoles("ADMIN", "ENCARGADO"), closeShift);

export default router;

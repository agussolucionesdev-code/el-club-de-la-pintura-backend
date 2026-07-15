import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeBranchAccess } from "../../middlewares/branch.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  closeShiftSchema,
  openShiftSchema,
} from "../../schemas/cash-register.schema";
import {
  getActiveShift,
  openShift,
  closeShift,
  getShiftHistory,
  generateCorteZPdf,
  registerCashMovement,
} from "./cash-register.controller";

const router = Router();

router.use(authenticateToken);

// Static routes first — must come before :param routes to avoid ambiguous matching
router.post(
  "/open",
  authorizeRoles("ADMIN", "ENCARGADO"),
  validate(openShiftSchema),
  authorizeBranchAccess(),
  openShift,
);
router.get(
  "/corte-z/pdf",
  authorizeRoles("ADMIN", "ENCARGADO"),
  generateCorteZPdf,
);

// Dynamic parameter routes
router.get(
  "/:branchId/active",
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  authorizeBranchAccess(),
  getActiveShift,
);
router.post(
  "/:id/close",
  authorizeRoles("ADMIN", "ENCARGADO"),
  validate(closeShiftSchema),
  closeShift,
);
router.post(
  "/:id/movement",
  authorizeRoles("ADMIN", "ENCARGADO"),
  registerCashMovement,
);
router.get(
  "/:branchId/history",
  authorizeRoles("ADMIN", "ENCARGADO"),
  authorizeBranchAccess({ allowAllBranches: true }),
  getShiftHistory,
);

export default router;

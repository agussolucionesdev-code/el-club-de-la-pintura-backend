import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  openShiftSchema,
  closeShiftSchema,
} from "../../schemas/cash-register.schema";
import {
  openShift,
  getActiveShiftStatus,
  closeShift,
} from "./cash-register.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"));

router.post("/open", validate(openShiftSchema), openShift);
router.get("/status/:branchId", getActiveShiftStatus);
router.post("/close/:branchId", validate(closeShiftSchema), closeShift);

export default router;

import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
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

// Todas las operaciones exigen Token. Los empleados operan la caja registradora.
router.use(verifyToken, authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"));

// Rutas de operación de turno
router.post("/open", validateSchema(openShiftSchema), openShift);
router.get("/status/:branchId", getActiveShiftStatus);
router.post("/close/:branchId", validateSchema(closeShiftSchema), closeShift);

export default router;

import { Router } from "express";
// Sincronización de nombres de middleware
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  onboardEmployeeSchema,
  modifyEmployeeSchema,
  resetPasswordSchema,
} from "../../schemas/user.schema";
import {
  authenticateUser,
  retrieveWorkforceDirectory,
  onboardEmployee,
  modifyEmployeeProfile,
  resetEmployeePassword,
  terminateEmployee,
} from "./user.controller";

const router = Router();

router.post("/login", authenticateUser);

// Directorio del personal (Protegido)
router.get("/", authenticateToken, retrieveWorkforceDirectory);

// Altas, Bajas y Modificaciones (ABM) con validación actualizada
router.post(
  "/",
  authenticateToken,
  validate(onboardEmployeeSchema),
  onboardEmployee,
);
router.put(
  "/:id",
  authenticateToken,
  validate(modifyEmployeeSchema),
  modifyEmployeeProfile,
);
router.delete("/:id", authenticateToken, terminateEmployee);

router.patch(
  "/:id/password",
  authenticateToken,
  validate(resetPasswordSchema),
  resetEmployeePassword,
);

export default router;

import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
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

// RUTAS PÚBLICAS
router.post("/login", authenticateUser);

// ============================================================================
// BARRERA DE SEGURIDAD GERENCIAL (RRHH)
// A partir de esta línea, SOLO Cristian y sus socios (ADMIN) pueden pasar.
// ============================================================================
router.use(verifyToken, authorizeRoles("ADMIN"));

// Directorio del personal
router.get("/", retrieveWorkforceDirectory);

// Altas, Bajas y Modificaciones (ABM)
router.post("/", validateSchema(onboardEmployeeSchema), onboardEmployee);
router.put("/:id", validateSchema(modifyEmployeeSchema), modifyEmployeeProfile);
router.delete("/:id", terminateEmployee);

// Módulo de Seguridad (Reseteo de claves de cajeros olvidadizos)
router.patch(
  "/:id/password",
  validateSchema(resetPasswordSchema),
  resetEmployeePassword,
);

export default router;

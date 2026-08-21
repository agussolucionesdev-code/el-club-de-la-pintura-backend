import { Router } from "express";
import rateLimit from "express-rate-limit";
import { authenticateToken, requireFullAuth } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  onboardEmployeeSchema,
  modifyEmployeeSchema,
  resetPasswordSchema,
} from "../../schemas/user.schema";
import { upload } from "../../middlewares/upload.middleware";
import {
  authenticateUser,
  logoutUser,
  retrieveWorkforceDirectory,
  onboardEmployee,
  modifyEmployeeProfile,
  resetEmployeePassword,
  terminateEmployee,
  getCurrentUserProfile,
  updateMyProfile,
  uploadMyAvatar,
  deleteMyAvatar,
  retrieveRoleCatalog,
  deleteUsersByRole,
  deleteAllOperationalRoleUsers,
} from "./user.controller";

const router = Router();

// Brute-force protection: max 10 login attempts per IP per 15 minutes.
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Demasiados intentos de inicio de sesión. Intente nuevamente en 15 minutos.",
  },
});

router.post("/login", loginRateLimiter, authenticateUser);
router.post("/logout", logoutUser);

router.get("/me", authenticateToken, getCurrentUserProfile);
router.patch("/me", authenticateToken, updateMyProfile);

// Own profile photo — every role, since each account manages its own. Must stay
// above the ADMIN guard below, which applies to everything after it.
router.post("/me/avatar", authenticateToken, upload.single("image"), uploadMyAvatar);
router.delete("/me/avatar", authenticateToken, deleteMyAvatar);

router.use(authenticateToken, authorizeRoles("ADMIN"));

/**
 * Las LECTURAS de acá abajo salen con sesión de código: la pantalla de Personal
 * tiene que poder abrirse desde el mostrador. Las ESCRITURAS llevan
 *  una por una, porque alta, baja, cambio de rol y
 * restablecimiento de contraseña son las acciones con las que alguien se haría
 * dueño del sistema — y seis dígitos tipeados frente a un cliente no son prueba
 * suficiente para eso.
 */

router.get("/", retrieveWorkforceDirectory);
router.get("/roles", retrieveRoleCatalog);
router.delete("/roles", requireFullAuth, deleteAllOperationalRoleUsers);
router.delete("/roles/:role/users", requireFullAuth, deleteUsersByRole);
router.post("/", requireFullAuth, validate(onboardEmployeeSchema), onboardEmployee);
router.put("/:id", requireFullAuth, validate(modifyEmployeeSchema), modifyEmployeeProfile);
router.delete("/:id", requireFullAuth, terminateEmployee);
router.patch("/:id/password", requireFullAuth, validate(resetPasswordSchema), resetEmployeePassword);

export default router;

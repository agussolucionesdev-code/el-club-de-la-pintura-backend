import { Router } from "express";
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
  getCurrentUserProfile,
  retrieveRoleCatalog,
  deleteUsersByRole,
  deleteAllOperationalRoleUsers,
} from "./user.controller";

const router = Router();

router.post("/login", authenticateUser);

router.get("/me", authenticateToken, getCurrentUserProfile);

router.use(authenticateToken, authorizeRoles("ADMIN"));

router.get("/", retrieveWorkforceDirectory);
router.get("/roles", retrieveRoleCatalog);
router.delete("/roles", deleteAllOperationalRoleUsers);
router.delete("/roles/:role/users", deleteUsersByRole);
router.post("/", validate(onboardEmployeeSchema), onboardEmployee);
router.put("/:id", validate(modifyEmployeeSchema), modifyEmployeeProfile);
router.delete("/:id", terminateEmployee);
router.patch("/:id/password", validate(resetPasswordSchema), resetEmployeePassword);

export default router;

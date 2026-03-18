import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createCustomerSchema } from "../../schemas/customer.schema";
import {
  retrieveCustomersLedger,
  retrieveCustomerProfile,
  registerCustomerProfile,
  modifyCustomerProfile,
  deactivateCustomerProfile,
} from "./customer.controller";

const router = Router();

router.get("/", authenticateToken, retrieveCustomersLedger);
router.get("/:id/profile", authenticateToken, retrieveCustomerProfile);

router.post(
  "/",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  validate(createCustomerSchema),
  registerCustomerProfile,
);

router.put(
  "/:id",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  modifyCustomerProfile,
);

router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("ADMIN"),
  deactivateCustomerProfile,
);

export default router;

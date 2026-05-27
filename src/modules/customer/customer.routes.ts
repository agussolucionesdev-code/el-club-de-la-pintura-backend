import { Router } from "express";
import {
  getCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from "./customer.controller";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  createCustomerSchema,
  updateCustomerSchema,
} from "../../schemas/customer.schema";

const router = Router();

// ============================================================================
// CUSTOMER DIRECTORY ROUTES (JWT-protected)
// ============================================================================

// 1. List active customers
router.get("/", authenticateToken, getCustomers);

// 2. Create a new customer profile (validated by Zod)
router.post(
  "/",
  authenticateToken,
  validate(createCustomerSchema),
  createCustomer,
);

// 3. Update an existing customer profile
router.put(
  "/:id",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validate(updateCustomerSchema),
  updateCustomer,
);

// 4. Archive a customer (soft delete)
router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  deleteCustomer,
);

export default router;

import { Router } from "express";
import {
  getCustomers,
  createCustomer,
  updateCustomer,
  deleteCustomer,
} from "./customer.controller";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  createCustomerSchema,
  updateCustomerSchema,
} from "../../schemas/customer.schema";

const router = Router();

// ============================================================================
// RUTAS DEL DIRECTORIO COMERCIAL (Protegidas por JWT)
// ============================================================================

// 1. Obtener la cartera de clientes activa
router.get("/", authenticateToken, getCustomers);

// 2. Dar de alta un nuevo perfil (Pasa por la aduana Zod)
router.post(
  "/",
  authenticateToken,
  validate(createCustomerSchema),
  createCustomer,
);

// 3. Modificar un perfil existente
router.put(
  "/:id",
  authenticateToken,
  validate(updateCustomerSchema),
  updateCustomer,
);

// 4. Archivar un cliente (Soft Delete)
router.delete("/:id", authenticateToken, deleteCustomer);

export default router;

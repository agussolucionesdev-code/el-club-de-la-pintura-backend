import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { createCustomerSchema } from "../../schemas/customer.schema";
import {
  getCustomers,
  createCustomer,
  updateCustomer,
} from "./customer.controller";

const router = Router();

// Todos los empleados pueden ver la lista de clientes y fiados
router.get("/", verifyToken, getCustomers);

// Creación de cliente: Validada estrictamente por Zod
router.post(
  "/",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"), // Todos pueden registrar un cliente nuevo
  validateSchema(createCustomerSchema),
  createCustomer,
);

// Actualización de datos del cliente
router.put(
  "/:id",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"), // Solo gerencia/encargados modifican perfiles
  updateCustomer,
);

export default router;

import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { createCustomerSchema } from "../../schemas/customer.schema";
import {
  retrieveCustomersLedger,
  retrieveCustomerProfile,
  registerCustomerProfile,
  modifyCustomerProfile,
} from "./customer.controller";

const router = Router();

// Rutas de lectura y listado
router.get("/", verifyToken, retrieveCustomersLedger);
router.get("/:id/profile", verifyToken, retrieveCustomerProfile); // NUEVO: Expediente detallado

// Rutas de mutación de datos
router.post(
  "/",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  validateSchema(createCustomerSchema),
  registerCustomerProfile,
);

router.put(
  "/:id",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  modifyCustomerProfile,
);

export default router;

import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { createSaleSchema } from "../../schemas/sale.schema";
import { processSale, getSales } from "./sale.controller";

const router = Router();

// Definición de la ruta POST para procesar carritos de compra (Punto de Venta)
// Candado 1: Autenticación (verifyToken)
// Candado 2: Autorización Comercial (authorizeRoles) - Todos pueden vender
// Candado 3: Validación Estructural (validateSchema)
router.post(
  "/",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  validateSchema(createSaleSchema),
  processSale,
);

// Definición de la ruta GET para auditar las finanzas y tickets generados
// Candado de Privacidad: Solo los Dueños (ADMIN) y Encargados pueden ver el historial
router.get("/", verifyToken, authorizeRoles("ADMIN", "ENCARGADO"), getSales);

export default router;

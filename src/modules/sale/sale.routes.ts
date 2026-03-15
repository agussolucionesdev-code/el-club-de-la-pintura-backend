import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { createSaleSchema } from "../../schemas/sale.schema";
import {
  executeCommercialTransaction,
  retrieveSalesHistory,
} from "./sale.controller";

const router = Router();

// ============================================================================
// PROCESAR PUNTO DE VENTA (Carrito de compras)
// ============================================================================
// Candado 1: Autenticación (verifyToken)
// Candado 2: Autorización Comercial (authorizeRoles) - Todos pueden vender
// Candado 3: Validación Estructural (validateSchema)
router.post(
  "/",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  validateSchema(createSaleSchema),
  executeCommercialTransaction,
);

// ============================================================================
// AUDITORÍA FINANCIERA (Historial de tickets con paginación)
// ============================================================================
// Candado de Privacidad: Solo los Dueños (ADMIN) y Encargados pueden ver el historial
router.get(
  "/",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  retrieveSalesHistory,
);

export default router;

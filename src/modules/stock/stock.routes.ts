import { Router } from "express";
import {
  getStockByBranch,
  updateStock,
  updateStockThresholds,
} from "./stock.controller";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware"; // <-- CORREGIDO: Importamos 'validate'
import {
  updateStockSchema,
  updateStockThresholdsSchema,
} from "../../schemas/stock.schema";

const router = Router();

// LECTURA: Obtener todo el inventario de una sucursal específica
router.get("/:branchId", authenticateToken, getStockByBranch);

// ESCRITURA: Movimientos de stock (Pasando por la aduana Zod)
router.put(
  "/update",
  authenticateToken,
  validate(updateStockSchema), // <-- CORREGIDO: Usamos 'validate'
  updateStock,
);

// CONFIGURACIÓN: Ajustar los mínimos para las alertas
router.put(
  "/thresholds",
  authenticateToken,
  validate(updateStockThresholdsSchema), // <-- CORREGIDO: Usamos 'validate'
  updateStockThresholds,
);

export default router;

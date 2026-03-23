import { Router } from "express";
import {
  getSales,
  getSaleById,
  createSale,
  getPendingAccounts, // <-- NUESTRA NUEVA JOYA
} from "./sale.controller";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createSaleSchema } from "../../schemas/sale.schema";

const router = Router();

// ============================================================================
// RUTAS DE VENTAS Y CUENTAS CORRIENTES (FIADOS)
// ============================================================================

// 1. RADAR DE DEUDORES: Obtener Cuentas Corrientes (¡Debe ir antes que /:id!)
router.get("/pending/:branchId", authenticateToken, getPendingAccounts);

// 2. HISTORIAL: Obtener todas las ventas (Ideal para el Dashboard de Cristian)
router.get("/", authenticateToken, getSales);

// 3. DETALLE DE TICKET: Recuperar una venta específica para reimprimir comprobante
router.get("/:id", authenticateToken, getSaleById);

// 4. NUEVA VENTA: Motor transaccional del POS (Protegido por JWT y Zod)
router.post("/", authenticateToken, validate(createSaleSchema), createSale);

export default router;

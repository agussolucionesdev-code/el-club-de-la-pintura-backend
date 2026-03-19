import { Router } from "express";
import { getSales, getSaleById, createSale } from "./sale.controller";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createSaleSchema } from "../../schemas/sale.schema";

const router = Router();

// ============================================================================
// RUTAS DE VENTAS Y PUNTO DE COBRO (POS)
// ============================================================================

// 1. HISTORIAL: Obtener todas las ventas (Ideal para el Dashboard de Cristian)
router.get("/", authenticateToken, getSales);

// 2. DETALLE DE TICKET: Recuperar una venta específica para reimprimir comprobante
router.get("/:id", authenticateToken, getSaleById);

// 3. NUEVA VENTA: Motor transaccional del POS (Protegido por JWT y Esquema Zod)
router.post("/", authenticateToken, validate(createSaleSchema), createSale);

export default router;

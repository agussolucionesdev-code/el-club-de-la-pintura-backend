import { Router } from "express";
import {
  getActiveShift,
  openShift,
  closeShift,
} from "./cash-register.controller";

// IMPORTANTE: Si ya tenés tu middleware de autenticación configurado,
// podés importarlo acá (ej: import { protect } from "../../middlewares/auth.middleware")
// y agregarlo como segundo parámetro en cada ruta.

const router = Router();

// ============================================================================
// RUTAS DE PUNTO DE VENTA Y CAJA (MOTOR FINANCIERO)
// ============================================================================

// 1. LECTURA: Verifica si hay una caja abierta en la sucursal
// Ruta: GET /api/cash-registers/:branchId/active
router.get("/:branchId/active", getActiveShift);

// 2. APERTURA: Inicia un nuevo turno con un fondo de cambio (sencillo)
// Ruta: POST /api/cash-registers/open
router.post("/open", openShift);

// 3. CIERRE (ARQUEO): Sella el turno y calcula diferencias (Sobrante/Faltante)
// Ruta: POST /api/cash-registers/:id/close
router.post("/:id/close", closeShift);

export default router;

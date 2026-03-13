import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { getStockByBranch, updateStock } from "./stock.controller";

const router = Router();

// Definición de ruta protegida para la consulta de inventario local
// Exige pasaporte digital (Token JWT) emitido por el sistema
router.get("/branch/:branchId", verifyToken, getStockByBranch);

// Definición de ruta protegida para el ingreso o egreso de mercadería
// Exige pasaporte digital (Token JWT) emitido por el sistema
router.post("/", verifyToken, updateStock);

export default router;

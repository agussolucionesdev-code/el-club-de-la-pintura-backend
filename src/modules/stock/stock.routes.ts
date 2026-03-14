import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import {
  updateStockSchema,
  updateStockThresholdsSchema,
} from "../../schemas/stock.schema";
import {
  getStockByBranch,
  updateStock,
  updateStockThresholds,
} from "./stock.controller";

const router = Router();

// CONSULTAR INVENTARIO
router.get("/branch/:branchId", verifyToken, getStockByBranch);

// INGRESAR/EGRESAR MERCADERÍA
router.post(
  "/",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validateSchema(updateStockSchema),
  updateStock,
);

// NUEVO: CONFIGURAR UMBRALES DE SEMÁFORO DINÁMICO
router.put(
  "/thresholds",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validateSchema(updateStockThresholdsSchema),
  updateStockThresholds,
);

export default router;

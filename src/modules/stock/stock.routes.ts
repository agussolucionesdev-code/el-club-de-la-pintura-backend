import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { updateStockSchema } from "../../schemas/stock.schema";
import { getStockByBranch, updateStock } from "./stock.controller";

const router = Router();

// Consulta de inventario: Abierto para todos los empleados (necesitan ver qué hay para vender)
router.get("/branch/:branchId", verifyToken, getStockByBranch);

// Ingreso de Mercadería (Camión) o Ajuste de Stock: Protección Máxima
// Solo Gerencia y Encargados pueden alterar físicamente el inventario o actualizar costos
router.post(
  "/",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validateSchema(updateStockSchema),
  updateStock,
);

export default router;

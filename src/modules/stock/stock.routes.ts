import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeBranchAccess } from "../../middlewares/branch.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  updateStockSchema,
  updateStockThresholdsSchema,
} from "../../schemas/stock.schema";
import {
  getReorderSuggestions,
  getStockAlertCount,
  getProductAvailability,
  getStockByBranch,
  getStockMovements,
  getStockTransfers,
  transferStockBetweenBranches,
  updateStock,
  updateStockThresholds,
} from "./stock.controller";

const router = Router();

router.use(authenticateToken);

router.get(
  "/transfers",
  authorizeRoles("ADMIN", "ENCARGADO"),
  getStockTransfers,
);

router.post(
  "/transfers",
  authorizeRoles("ADMIN", "ENCARGADO"),
  transferStockBetweenBranches,
);

router.get(
  "/reorder-suggestions",
  authorizeRoles("ADMIN", "ENCARGADO"),
  getReorderSuggestions,
);
router.get(
  "/alerts/count",
  authorizeRoles("ADMIN", "ENCARGADO"),
  getStockAlertCount,
);
router.get(
  "/movements",
  authorizeRoles("ADMIN", "ENCARGADO"),
  getStockMovements,
);

/**
 * Va ANTES de `/:branchId` a propósito.
 *
 * Son dos segmentos, así que hoy no colisionan — pero si alguien la mueve más
 * abajo y en el futuro aparece una ruta comodín, `/availability/5` empezaría a
 * resolverse como "la sucursal llamada availability". Arriba no puede pasar.
 *
 * Sin `authorizeRoles`: acá la autorización es por CAPACIDAD y la resuelve el
 * controlador. Un empleado con `stock:view_all_branches` tiene que poder
 * entrar, y un filtro por rol lo dejaría afuera.
 */
router.get("/availability/:productId", getProductAvailability);

router.get(
  "/:branchId",
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  authorizeBranchAccess({ allowAllBranches: true }),
  getStockByBranch,
);

router.put(
  "/update",
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  authorizeBranchAccess(),
  validate(updateStockSchema),
  updateStock,
);

router.put(
  "/thresholds",
  authorizeRoles("ADMIN", "ENCARGADO"),
  authorizeBranchAccess(),
  validate(updateStockThresholdsSchema),
  updateStockThresholds,
);

export default router;

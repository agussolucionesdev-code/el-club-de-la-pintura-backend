import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
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

router.get("/branch/:branchId", authenticateToken, getStockByBranch);

router.post(
  "/",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validate(updateStockSchema),
  updateStock,
);

router.put(
  "/thresholds",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validate(updateStockThresholdsSchema),
  updateStockThresholds,
);

export default router;

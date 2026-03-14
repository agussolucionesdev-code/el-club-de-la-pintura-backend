import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { payDebt } from "./payment.controller";

const router = Router();

// Ruta para cobrar deudas y saldos pendientes
router.post(
  "/",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"), // El cajero puede cobrar
  payDebt,
);

export default router;

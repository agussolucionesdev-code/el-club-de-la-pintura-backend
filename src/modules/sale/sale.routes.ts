import { Router } from "express";
import { getSales, getSaleById, createSale } from "./sale.controller";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createSaleSchema } from "../../schemas/sale.schema";

const router = Router();

// Rutas protegidas para la gestión de ventas
router.get("/", authenticateToken, getSales);
router.get("/:id", authenticateToken, getSaleById);
router.post("/", authenticateToken, validate(createSaleSchema), createSale);

export default router;

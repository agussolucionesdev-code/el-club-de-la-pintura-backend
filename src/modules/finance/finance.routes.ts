import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { getDailyRevenue, getTopSellingProducts } from "./finance.controller";

const router = Router();

// ============================================================================
// BÓVEDA FINANCIERA - REGLA DE NEGOCIO ESTRICTA
// ============================================================================
// Todas las rutas de este módulo exigen autenticación Y rol de Alta Gerencia.
// Ni los Encargados ni los Empleados pueden acceder a los márgenes o recaudación.
router.use(verifyToken, authorizeRoles("ADMIN"));

// Definición de la ruta GET para ingresos del día
router.get("/daily-revenue", getDailyRevenue);

// Definición de la ruta GET para el ranking de rotación de productos
router.get("/top-products", getTopSellingProducts);

export default router;

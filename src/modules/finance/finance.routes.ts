import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { getDailyRevenue, getTopSellingProducts } from "./finance.controller";

const router = Router();

// Finance vault — all routes require ADMIN role
router.use(authenticateToken, authorizeRoles("ADMIN"));

router.get("/daily-revenue", getDailyRevenue);
router.get("/top-products", getTopSellingProducts);

export default router;

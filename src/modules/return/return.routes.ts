import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { createReturn, getReturnsBySale } from "./return.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO"));

router.post("/:id/return", createReturn);
router.get("/:id/returns", getReturnsBySale);

export default router;

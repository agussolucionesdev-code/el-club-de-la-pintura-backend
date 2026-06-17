import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createReturnSchema } from "../../schemas/return.schema";
import { createReturn, getReturnsBySale } from "./return.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO"));

router.post("/:id/return", validate(createReturnSchema), createReturn);
router.get("/:id/returns", getReturnsBySale);

export default router;

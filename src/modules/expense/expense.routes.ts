import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { registerExpenseSchema } from "../../schemas/expense.schema";
import { registerExpense } from "./expense.controller";

const router = Router();

// Cualquier empleado con la caja abierta puede (y debe) registrar si saca dinero
router.use(verifyToken, authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"));

router.post("/", validateSchema(registerExpenseSchema), registerExpense);

export default router;

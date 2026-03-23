import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { registerExpenseSchema } from "../../schemas/expense.schema";
import { registerExpense, getExpenses } from "./expense.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"));

// 🛡️ NUEVA RUTA GET: Lee el historial y soluciona el 404
router.get("/", getExpenses);

router.post("/", validate(registerExpenseSchema), registerExpense);

export default router;

import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeBranchAccess } from "../../middlewares/branch.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { registerExpenseSchema } from "../../schemas/expense.schema";
import { upload } from "../../middlewares/upload.middleware";
import {
  registerExpense,
  getExpenses,
  voidExpense,
  updateExpense,
  uploadExpenseReceipt,
  getBudgets,
  upsertBudget,
  deleteBudget,
  getRecurring,
  createRecurring,
  deleteRecurring,
  runRecurring,
} from "./expense.controller";
import {
  createExpenseCategory,
  deleteExpenseCategory,
  listExpenseCategories,
  updateExpenseCategory,
} from "./expenseCategory.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO"));

// ── Categorías ────────────────────────────────────────────────────────────
// Listar puede cualquiera que entre a Gastos: la pantalla las necesita para
// nombrar y colorear. Crear, editar y borrar es sólo del dueño, y eso lo
// resuelve el controlador.
router.get("/categories", listExpenseCategories);
router.post("/categories", createExpenseCategory);
router.patch("/categories/:id", updateExpenseCategory);
router.delete("/categories/:id", deleteExpenseCategory);

router.get("/", getExpenses);
router.get("/budgets", getBudgets);
router.put("/budgets", upsertBudget);
router.delete("/budgets/:id", deleteBudget);
router.get("/recurring", getRecurring);
router.post("/recurring", createRecurring);
router.delete("/recurring/:id", deleteRecurring);
router.post("/recurring/:id/run", runRecurring);
router.post("/receipt-upload", upload.single("file"), uploadExpenseReceipt);
router.post(
  "/",
  authorizeBranchAccess(),
  validate(registerExpenseSchema),
  registerExpense,
);
router.patch("/:id", updateExpense);
router.post("/:id/void", voidExpense);

export default router;

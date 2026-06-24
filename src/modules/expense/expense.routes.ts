import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeBranchAccess } from "../../middlewares/branch.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { registerExpenseSchema } from "../../schemas/expense.schema";
import {
  registerExpense,
  getExpenses,
  voidExpense,
  updateExpense,
} from "./expense.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO"));

router.get("/", getExpenses);
router.post(
  "/",
  authorizeBranchAccess(),
  validate(registerExpenseSchema),
  registerExpense,
);
router.patch("/:id", updateExpense);
router.post("/:id/void", voidExpense);

export default router;

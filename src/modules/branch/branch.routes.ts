import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  createBranchSchema,
  updateBranchSchema,
} from "../../schemas/branch.schema";
import {
  getBranches,
  createBranch,
  updateBranch,
  deleteBranch,
  deleteAllBranches,
} from "./branch.controller";

const router = Router();

router.use(authenticateToken);

router.get("/", authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"), getBranches);
router.post("/", authorizeRoles("ADMIN"), validate(createBranchSchema), createBranch);
router.delete("/", authorizeRoles("ADMIN"), deleteAllBranches);
router.put("/:id", authorizeRoles("ADMIN"), validate(updateBranchSchema), updateBranch);
router.delete("/:id", authorizeRoles("ADMIN"), deleteBranch);

export default router;

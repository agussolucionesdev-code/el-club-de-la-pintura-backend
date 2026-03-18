import { Router } from "express";
// Sincronización de nombre de middleware
import { authenticateToken } from "../../middlewares/auth.middleware";
import {
  getBranches,
  createBranch,
  updateBranch,
  deleteBranch,
} from "./branch.controller";

const router = Router();

router.get("/", getBranches);

// Aplicación del nuevo nombre de interceptor
router.post("/", authenticateToken, createBranch);
router.put("/:id", authenticateToken, updateBranch);
router.delete("/:id", authenticateToken, deleteBranch);

export default router;

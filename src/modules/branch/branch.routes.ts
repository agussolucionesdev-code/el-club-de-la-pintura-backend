import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import {
  getBranches,
  createBranch,
  updateBranch,
  deleteBranch,
} from "./branch.controller";

const router = Router();

// Definición de la ruta GET pública para la obtención de sucursales
router.get("/", getBranches);

// Definición de rutas protegidas (Exigen validación de token JWT en cabecera)
router.post("/", verifyToken, createBranch);
router.put("/:id", verifyToken, updateBranch);
router.delete("/:id", verifyToken, deleteBranch);

export default router;

import { Router } from "express";
import {
  getBranches,
  createBranch,
  updateBranch,
  deleteBranch,
} from "./branch.controller";

const router = Router();

// Definición de la ruta GET para la obtención de sucursales
router.get("/", getBranches);

// Definición de la ruta POST para la creación de una nueva sucursal
router.post("/", createBranch);

// Definición de la ruta PUT para la actualización de una sucursal específica por ID
router.put("/:id", updateBranch);

// Definición de la ruta DELETE para la eliminación de una sucursal específica por ID
router.delete("/:id", deleteBranch);

export default router;

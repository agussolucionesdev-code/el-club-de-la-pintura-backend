import { Router } from "express";
import { getBranches } from "../controllers/branch.controller";

const router = Router();

// Definimos la ruta GET para obtener las sucursales
router.get("/", getBranches);

export default router;

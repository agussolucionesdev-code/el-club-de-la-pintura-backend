import { Router } from "express";
import { verifyToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { createSupplierSchema } from "../../schemas/supplier.schema";
import {
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from "./supplier.controller";

const router = Router();

// ============================================================================
// BARRERA DE SEGURIDAD: COMPRAS Y PROVEEDORES
// ============================================================================
// Se exige token y rol gerencial para todas las rutas de este archivo
router.use(verifyToken, authorizeRoles("ADMIN", "ENCARGADO"));

// Operaciones CRUD
router.get("/", getSuppliers);
router.post("/", validateSchema(createSupplierSchema), createSupplier);
router.put("/:id", updateSupplier);
router.delete("/:id", deleteSupplier); // Borrado Lógico

export default router;

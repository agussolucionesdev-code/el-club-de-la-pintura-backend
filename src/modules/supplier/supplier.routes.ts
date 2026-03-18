import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createSupplierSchema } from "../../schemas/supplier.schema";
import {
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from "./supplier.controller";

const router = Router();

// Aplicación de barrera de seguridad con nombres actualizados
router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO"));

router.get("/", getSuppliers);
router.post("/", validate(createSupplierSchema), createSupplier);
router.put("/:id", updateSupplier);
router.delete("/:id", deleteSupplier);

export default router;

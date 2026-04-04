import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createSupplierSchema } from "../../schemas/supplier.schema";

// 🛡️ IMPORTACIONES BLINDADAS (Tienen que coincidir exacto con supplier.controller.ts)
import {
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from "./supplier.controller";

// 🛡️ IMPORTAMOS NUESTRO MOTOR DE SIEMBRA
import { seedSuppliers } from "./supplier.seeder";

const router = Router();

// 🚀 RUTA SECRETA DE SIEMBRA
// (La ponemos ANTES de la seguridad para que puedas ejecutarla directo desde el navegador)
router.get("/seed-magico", seedSuppliers);

// ================================================================
// 🔒 Aplicación de barrera de seguridad con nombres actualizados
router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO"));
// ================================================================

router.get("/", getSuppliers);
router.post("/", validate(createSupplierSchema), createSupplier);
router.put("/:id", updateSupplier);
router.delete("/:id", deleteSupplier);

export default router;

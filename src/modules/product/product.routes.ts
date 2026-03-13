import { Router } from "express";
import { upload } from "../../middlewares/upload.middleware";
import { verifyToken } from "../../middlewares/auth.middleware";
// NUEVO: Importamos el patovica de roles y la aduana de Zod
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validateSchema } from "../../middlewares/validate.middleware";
import { createProductSchema } from "../../schemas/product.schema";
import {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  uploadProductImage,
  importProductsFromExcel,
} from "./product.controller";

const router = Router();

// Definición de la ruta GET pública para la obtención del catálogo
// (Todo el equipo necesita ver el catálogo para poder vender)
router.get("/", getProducts);

// ============================================================================
// RUTAS PROTEGIDAS (Requieren Token JWT y Privilegios Comerciales)
// ============================================================================

// Endpoint para la ingesta masiva de catálogo vía Excel
// Seguridad: Solo Gerencia y Encargados
router.post(
  "/import",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  upload.single("file"),
  importProductsFromExcel,
);

// Inyección concurrente de validación de seguridad e intercepción de imágenes
// Seguridad: Solo Gerencia y Encargados
router.post(
  "/upload-image",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  upload.single("image"),
  uploadProductImage,
);

// Operaciones CRUD estándar
// Creación: Protegida por Roles y Validada matemáticamente por Zod
router.post(
  "/",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validateSchema(createProductSchema),
  createProduct,
);

// Actualización: Protegida por Roles
router.put(
  "/:id",
  verifyToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  updateProduct,
);

// Eliminación: Privilegio EXCLUSIVO del Dueño (Prevención de sabotaje)
router.delete("/:id", verifyToken, authorizeRoles("ADMIN"), deleteProduct);

export default router;

import { Router } from "express";
import { upload } from "../../middlewares/upload.middleware";
import { verifyToken } from "../../middlewares/auth.middleware";
import {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  uploadProductImage,
  importProductsFromExcel, // <-- Verificá que esta importación esté presente
} from "./product.controller";

const router = Router();

// Definición de la ruta GET pública para la obtención del catálogo
router.get("/", getProducts);

// RUTAS PROTEGIDAS (Requieren Token JWT)
// NUEVO: Endpoint para la ingesta masiva de catálogo vía Excel
router.post(
  "/import",
  verifyToken,
  upload.single("file"),
  importProductsFromExcel,
);

// Inyección concurrente de validación de seguridad e intercepción de imágenes
router.post(
  "/upload-image",
  verifyToken,
  upload.single("image"),
  uploadProductImage,
);

// Operaciones CRUD estándar
router.post("/", verifyToken, createProduct);
router.put("/:id", verifyToken, updateProduct);
router.delete("/:id", verifyToken, deleteProduct);

export default router;

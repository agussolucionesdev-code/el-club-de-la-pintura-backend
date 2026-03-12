import { Router } from "express";
import { upload } from "../../middlewares/upload.middleware";
import { verifyToken } from "../../middlewares/auth.middleware";
import {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  uploadProductImage,
} from "./product.controller";

const router = Router();

// Definición de la ruta GET pública para la obtención del catálogo
router.get("/", getProducts);

// Definición de rutas protegidas (Exigen validación de token JWT en cabecera)
// Inyección concurrente de validación de seguridad e intercepción de archivos
router.post(
  "/upload-image",
  verifyToken,
  upload.single("image"),
  uploadProductImage,
);
router.post("/", verifyToken, createProduct);
router.put("/:id", verifyToken, updateProduct);
router.delete("/:id", verifyToken, deleteProduct);

export default router;

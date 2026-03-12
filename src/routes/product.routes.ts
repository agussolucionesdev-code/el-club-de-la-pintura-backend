import { Router } from "express";
import {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/product.controller";

const router = Router();

// Definición de la ruta GET para la obtención del catálogo
router.get("/", getProducts);

// Definición de la ruta POST para la creación de un producto
router.post("/", createProduct);

// Definición de la ruta PUT para la actualización de un producto por ID
router.put("/:id", updateProduct);

// Definición de la ruta DELETE para la eliminación de un producto por ID
router.delete("/:id", deleteProduct);

export default router;

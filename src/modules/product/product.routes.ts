import { Router } from "express";
import { upload, uploadToDisk } from "../../middlewares/upload.middleware";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createProductSchema, updateProductSchema } from "../../schemas/product.schema";
import {
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  deleteAllProducts,
  uploadProductImage,
  importProductsFromExcel,
} from "./product.controller";
import { startBulkPriceUpdate, getBulkPriceUpdateStatus } from "./bulk-price.controller";
import { posSearchProducts } from "./posSearch.controller";

const router = Router();

router.get(
  "/",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  getProducts,
);

/**
 * La búsqueda del mostrador.
 *
 * Va ANTES de `/:id` porque si no, "pos-search" se resolvería como un id de
 * producto y devolvería un 400 que no explica nada.
 *
 * Existe aparte de `GET /` porque resuelve otro problema: `GET /` pagina el
 * catálogo para pantallas de administración, y el POS necesita encontrar UNO
 * entre veinte mil sin bajarse ninguno. Ver `posSearch.controller.ts`.
 */
router.get(
  "/pos-search",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  posSearchProducts,
);

router.post(
  "/import",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  importProductsFromExcel,
);

router.post(
  "/upload-image",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  upload.single("image"),
  uploadProductImage,
);

router.post(
  "/",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validate(createProductSchema),
  createProduct,
);

router.post(
  "/bulk-price-update",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  uploadToDisk.single("file"),
  startBulkPriceUpdate,
);

router.get(
  "/bulk-price-update/:jobId",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  getBulkPriceUpdateStatus,
);

router.delete(
  "/delete-all",
  authenticateToken,
  authorizeRoles("ADMIN"),
  deleteAllProducts,
);

router.put(
  "/:id",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validate(updateProductSchema),
  updateProduct,
);

router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("ADMIN"),
  deleteProduct,
);

export default router;

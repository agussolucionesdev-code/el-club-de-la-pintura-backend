import { Router } from "express";
import { upload, uploadToDisk } from "../../middlewares/upload.middleware";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createProductSchema } from "../../schemas/product.schema";
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

const router = Router();

router.get(
  "/",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"),
  getProducts,
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
  updateProduct,
);

router.delete(
  "/:id",
  authenticateToken,
  authorizeRoles("ADMIN"),
  deleteProduct,
);

export default router;

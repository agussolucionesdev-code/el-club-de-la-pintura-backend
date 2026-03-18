import { Router } from "express";
import { upload } from "../../middlewares/upload.middleware";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
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

router.get("/", getProducts);

router.post(
  "/import",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  upload.single("file"),
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

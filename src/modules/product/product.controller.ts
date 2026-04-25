// Importación de interfaces HTTP y ORM
import { Request, Response } from "express";
import prisma from "../../config/db";
import { Prisma } from "@prisma/client";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
// Importación de utilidades de procesamiento y almacenamiento
import * as xlsx from "xlsx";
import cloudinary from "../../config/cloudinary";

// 🧠 IA BACKEND: MOTOR DE NORMALIZACIÓN (Data Cleansing)
// Estandariza volúmenes y textos para evitar duplicados en la base de datos
const normalizeProductName = (name: string): string => {
  let cleanName = name.trim().toUpperCase();
  // Normaliza "x20", "20 Lts", "20L" -> "20 L"
  cleanName = cleanName.replace(/(\d+)\s*(LTS|LT|L)\b/gi, "$1 L");
  cleanName = cleanName.replace(/X\s*(\d+)/gi, "$1 L");
  // Limpia espacios dobles
  cleanName = cleanName.replace(/\s{2,}/g, " ");
  return cleanName;
};

const parseOptionalStockInput = (stock: unknown) => {
  if (stock === undefined || stock === null || stock === "") return null;

  const parsedStock = Number(stock);
  if (!Number.isInteger(parsedStock) || parsedStock < 0) {
    throw new Error("El stock informado debe ser un numero entero positivo.");
  }

  return parsedStock;
};

const parseStockBranchId = (body: Record<string, unknown>) => {
  const rawBranchId = body.stockBranchId ?? body.branchId;
  const branchId = Number(rawBranchId);

  if (!Number.isInteger(branchId) || branchId <= 0) {
    throw new Error(
      "Para modificar stock desde catalogo debes elegir una sucursal especifica.",
    );
  }

  return branchId;
};

const ensureProductBranchAccess = (
  branchId: number,
  authUser: { role: string; branchIds: number[] },
) => {
  if (authUser.role === "ADMIN") return;

  if (!authUser.branchIds.includes(branchId)) {
    throw new Error("No tienes permisos para modificar stock en esa sucursal.");
  }
};

const isOperationalProductError = (error: unknown) =>
  error instanceof Error &&
  (error.message.includes("stock informado") ||
    error.message.includes("modificar stock") ||
    error.message.includes("sucursal especifica") ||
    error.message.includes("sucursal indicada"));

const applyCatalogStockSnapshot = async (
  tx: Prisma.TransactionClient,
  {
    productId,
    branchId,
    quantity,
    userId,
    reason,
  }: {
    productId: number;
    branchId: number;
    quantity: number;
    userId: number;
    reason: string;
  },
) => {
  const branch = await tx.branch.findUnique({ where: { id: branchId } });
  if (!branch) {
    throw new Error("La sucursal indicada para stock no existe.");
  }

  const currentStock = await tx.stock.findUnique({
    where: { productId_branchId: { productId, branchId } },
  });
  const previousQuantity = currentStock?.quantity || 0;
  const delta = quantity - previousQuantity;

  const stock = await tx.stock.upsert({
    where: { productId_branchId: { productId, branchId } },
    update: { quantity },
    create: {
      productId,
      branchId,
      quantity,
      minStock: 5,
    },
  });

  if (delta !== 0) {
    await tx.movement.create({
      data: {
        type: "CATALOG_ADJUST",
        quantity: delta,
        reason,
        productId,
        branchId,
        userId,
      },
    });
  }

  return stock;
};

// ============================================================================
// LECTURA DE CATÁLOGO: Paginación, búsqueda y filtros
// ============================================================================
// ============================================================================
// LECTURA DE CATÁLOGO: Paginación, búsqueda y filtros
// ============================================================================
export const getProducts = async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = 10, search, category, brand } = req.query;

    const pageNumber = Number(page);
    const pageSize = Number(limit);
    const skip = (pageNumber - 1) * pageSize;

    // 🛡️ INYECCIÓN DE SEGURIDAD Y TIPADO FUERTE
    const whereClause: Prisma.ProductWhereInput = { isActive: true };

    if (category) whereClause.category = String(category);
    if (brand) whereClause.brand = String(brand);

    if (search) {
      const searchString = String(search);
      whereClause.OR = [
        { name: { contains: searchString, mode: "insensitive" } },
        { sku: { contains: searchString, mode: "insensitive" } },
        { barcode: { contains: searchString, mode: "insensitive" } },
        { description: { contains: searchString, mode: "insensitive" } },
      ];
    }

    const [totalRecords, products] = await prisma.$transaction([
      prisma.product.count({ where: whereClause }),
      prisma.product.findMany({
        where: whereClause,
        skip: skip,
        take: pageSize,
        orderBy: { createdAt: "desc" },
        include: {
          supplier: {
            select: { id: true, companyName: true },
          },
          stocks: true, // 🧠 ¡ACÁ ESTÁ LA MAGIA! Le decimos al backend que envíe el stock en tiempo real
        },
      }),
    ]);

    const totalPages = Math.ceil(totalRecords / pageSize);

    res.status(200).json({
      metadata: { totalRecords, totalPages, currentPage: pageNumber, pageSize },
      data: products,
    });
  } catch (error) {
    console.error("Error al buscar los productos:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al obtener el catálogo de productos." });
  }
};

// ============================================================================
// CREACIÓN INDIVIDUAL: Ingreso de nuevo producto
// ============================================================================
export const createProduct = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const {
      sku,
      barcode,
      name,
      brand,
      category,
      description,
      costPrice,
      retailPrice,
      wholesalePrice,
      ivaPercentage,
      color,
      finish,
      volume,
      volumeUnit,
      indoorOutdoor,
      baseType,
      images,
      supplierId,
      stock,
      stockBranchId,
      branchId,
      status,
      metadata: reqMetadata,
      ...extraData
    } = req.body;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    if (!sku || !name || !brand || !category) {
      return res.status(400).json({
        error: "Los campos sku, name, brand y category son requeridos.",
      });
    }

    const parsedStock = parseOptionalStockInput(stock);
    const parsedStockBranchId =
      parsedStock === null
        ? null
        : parseStockBranchId({ stockBranchId, branchId });

    if (parsedStockBranchId !== null) {
      ensureProductBranchAccess(parsedStockBranchId, authUser);
    }

    const existingSku = await prisma.product.findUnique({ where: { sku } });
    if (existingSku)
      return res
        .status(400)
        .json({ error: "El SKU ingresado ya se encuentra registrado." });

    if (barcode) {
      const existingBarcode = await prisma.product.findUnique({
        where: { barcode },
      });
      if (existingBarcode)
        return res
          .status(400)
          .json({ error: "El código de barras ya existe." });
    }

    const flatMetadata = {
      ...(reqMetadata || {}),
      ...(parsedStock !== null && {
        stock: parsedStock,
        initialStockImported: parsedStock,
        stockBranchId: parsedStockBranchId,
      }),
      ...(status && { status }),
      ...extraData,
    };

    const newProduct = await prisma.$transaction(async (tx) => {
      const createdProduct = await tx.product.create({
      data: {
        sku,
        barcode: barcode || null,
        name: normalizeProductName(name), // 🧠 Normalizamos al crear
        brand,
        category,
        description,
        costPrice: costPrice !== undefined ? Number(costPrice) : null,
        retailPrice: retailPrice !== undefined ? Number(retailPrice) : null,
        wholesalePrice:
          wholesalePrice !== undefined ? Number(wholesalePrice) : null,
        ivaPercentage:
          ivaPercentage !== undefined ? Number(ivaPercentage) : 21.0,
        color,
        finish,
        volume,
        volumeUnit,
        indoorOutdoor,
        baseType,
        images: images || [],
        supplierId: supplierId ? Number(supplierId) : null,
        metadata:
          Object.keys(flatMetadata).length > 0 ? flatMetadata : Prisma.DbNull,
      },
      });

      if (parsedStock !== null && parsedStockBranchId !== null) {
        await applyCatalogStockSnapshot(tx, {
          productId: createdProduct.id,
          branchId: parsedStockBranchId,
          quantity: parsedStock,
          userId: authUser.id,
          reason: "Alta de stock inicial desde catalogo",
        });
      }

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: parsedStockBranchId,
          action: "PRODUCT_CREATED",
          entityType: "Product",
          entityId: String(createdProduct.id),
          metadata: {
            sku,
            name: createdProduct.name,
            brand,
            category,
            retailPrice:
              retailPrice !== undefined ? Number(retailPrice) : null,
            initialStock: parsedStock,
          },
        },
      });

      return tx.product.findUnique({
        where: { id: createdProduct.id },
        include: {
          supplier: { select: { id: true, companyName: true } },
          stocks: true,
        },
      });
    });

    res.status(201).json(newProduct);
  } catch (error) {
    if (!isOperationalProductError(error)) {
      console.error("Error al crear el producto:", error);
    }
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Hubo un problema al registrar el producto.";
    res.status(400).json({ error: errorMsg });
  }
};

// ============================================================================
// ACTUALIZACIÓN: Modificación de producto existente
// ============================================================================
export const updateProduct = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { id } = req.params;
    const {
      sku,
      barcode,
      name,
      brand,
      category,
      description,
      costPrice,
      profitMargin,
      ivaPercentage,
      retailPrice,
      wholesalePrice,
      color,
      finish,
      volume,
      volumeUnit,
      indoorOutdoor,
      baseType,
      images,
      supplierId,
      stock,
      stockBranchId,
      branchId,
      status,
      metadata: reqMetadata,
      ...extraData
    } = req.body;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const parsedStock = parseOptionalStockInput(stock);
    const parsedStockBranchId =
      parsedStock === null
        ? null
        : parseStockBranchId({ stockBranchId, branchId });

    if (parsedStockBranchId !== null) {
      ensureProductBranchAccess(parsedStockBranchId, authUser);
    }

    const activeProduct = await prisma.product.findFirst({
      where: { id: Number(id), isActive: true },
    });

    if (!activeProduct)
      return res
        .status(404)
        .json({ error: "El producto no existe o fue archivado." });

    const existingMeta =
      typeof activeProduct.metadata === "object" &&
      activeProduct.metadata !== null
        ? activeProduct.metadata
        : {};

    const flatMetadata = {
      ...existingMeta,
      ...(reqMetadata || {}),
      ...(parsedStock !== null && {
        stock: parsedStock,
        initialStockImported: parsedStock,
        stockBranchId: parsedStockBranchId,
      }),
      ...(status && { status }),
      ...extraData,
    };

    const finalCost =
      costPrice !== undefined
        ? Number(costPrice)
        : Number(activeProduct.costPrice || 0);
    const finalMargin =
      profitMargin !== undefined
        ? Number(profitMargin)
        : Number(activeProduct.profitMargin || 30);
    const finalIva =
      ivaPercentage !== undefined
        ? Number(ivaPercentage)
        : Number(activeProduct.ivaPercentage || 21);

    const calculatedRetail =
      retailPrice !== undefined && Number(retailPrice) > 0
        ? Number(retailPrice)
        : Math.round(
            finalCost * (1 + finalMargin / 100) * (1 + finalIva / 100),
          );

    const updatedProduct = await prisma.$transaction(async (tx) => {
      await tx.product.update({
      where: { id: Number(id) },
      data: {
        sku,
        barcode: barcode || null,
        name: name ? normalizeProductName(name) : activeProduct.name, // 🧠 Normalizamos al actualizar
        brand,
        category,
        description,
        costPrice: finalCost,
        profitMargin: finalMargin,
        ivaPercentage: finalIva,
        retailPrice: calculatedRetail,
        wholesalePrice:
          wholesalePrice !== undefined ? Number(wholesalePrice) : null,
        color,
        finish,
        volume,
        volumeUnit,
        indoorOutdoor,
        baseType,
        images: images || [],
        supplierId: supplierId ? Number(supplierId) : null,
        metadata:
          Object.keys(flatMetadata).length > 0 ? flatMetadata : Prisma.DbNull,
      },
      });
      if (parsedStock !== null && parsedStockBranchId !== null) {
        await applyCatalogStockSnapshot(tx, {
          productId: Number(id),
          branchId: parsedStockBranchId,
          quantity: parsedStock,
          userId: authUser.id,
          reason: "Ajuste de stock desde catalogo",
        });
      }

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: parsedStockBranchId,
          action: "PRODUCT_UPDATED",
          entityType: "Product",
          entityId: String(id),
          metadata: {
            previous: {
              sku: activeProduct.sku,
              name: activeProduct.name,
              brand: activeProduct.brand,
              category: activeProduct.category,
              costPrice: activeProduct.costPrice,
              retailPrice: activeProduct.retailPrice,
            },
            next: {
              sku,
              name: name ? normalizeProductName(name) : activeProduct.name,
              brand,
              category,
              costPrice: finalCost,
              retailPrice: calculatedRetail,
              stock: parsedStock,
            },
          },
        },
      });

      return tx.product.findUnique({
        where: { id: Number(id) },
        include: {
          supplier: { select: { id: true, companyName: true } },
          stocks: true,
        },
      });
    });

    res.status(200).json(updatedProduct);
  } catch (error) {
    if (!isOperationalProductError(error)) {
      console.error("Error al actualizar el producto:", error);
    }
    const errorMsg =
      error instanceof Error ? error.message : "No se pudo actualizar el producto.";
    res.status(400).json({ error: errorMsg });
  }
};

export const deleteProduct = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { id } = req.params;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const archivedProduct = await prisma.product.update({
      where: { id: Number(id) },
      data: { isActive: false },
    });

    await prisma.auditLog.create({
      data: {
        actorUserId: authUser.id,
        action: "PRODUCT_ARCHIVED",
        entityType: "Product",
        entityId: String(archivedProduct.id),
        metadata: {
          sku: archivedProduct.sku,
          name: archivedProduct.name,
          brand: archivedProduct.brand,
        },
      },
    });
    res.status(200).json({ message: "Producto retirado del catálogo." });
  } catch (error) {
    res.status(500).json({ error: "No se pudo archivar el producto." });
  }
};

// ============================================================================
// Archivado masivo controlado de productos activos.
// ============================================================================
export const deleteAllProducts = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const {
      confirmationPhrase,
      expectedActiveCount,
    }: { confirmationPhrase?: unknown; expectedActiveCount?: unknown } =
      req.body || {};

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    if (confirmationPhrase !== "VACIAR") {
      return res.status(400).json({
        error:
          "Confirmacion requerida: envie la frase exacta VACIAR para archivar el catalogo activo.",
      });
    }

    const totalActive = await prisma.product.count({
      where: { isActive: true },
    });

    const expectedCount = Number(expectedActiveCount);
    if (
      expectedActiveCount !== undefined &&
      (!Number.isInteger(expectedCount) || expectedCount !== totalActive)
    ) {
      return res.status(409).json({
        error:
          "El catalogo cambio desde que se inicio la accion. Actualice la pantalla y vuelva a confirmar.",
        data: {
          expectedActiveCount,
          currentActiveCount: totalActive,
        },
      });
    }

    if (totalActive === 0) {
      return res
        .status(200)
        .json({ message: "El catálogo ya estaba vacío.", deletedCount: 0 });
    }

    const result = await prisma.product.updateMany({
      where: { isActive: true },
      data: { isActive: false },
    });

    await prisma.auditLog.create({
      data: {
        actorUserId: authUser.id,
        action: "PRODUCT_CATALOG_ARCHIVED",
        entityType: "Product",
        entityId: "ALL_ACTIVE",
        metadata: {
          deletedCount: result.count,
          reason: "Archivado masivo desde catalogo/listas de precios",
        },
      },
    });

    res.status(200).json({
      message: "Directorio de Tarifas vaciado con éxito.",
      deletedCount: result.count,
    });
  } catch (error) {
    console.error("Error crítico al vaciar el catálogo:", error);
    res.status(500).json({
      error: "Fallo estructural al intentar vaciar la base de datos.",
    });
  }
};

export const uploadProductImage = async (req: Request, res: Response) => {
  try {
    if (!req.file)
      return res
        .status(400)
        .json({ error: "No se proporcionó archivo de imagen." });

    const b64 = Buffer.from(req.file.buffer).toString("base64");
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    const uploadResult = await cloudinary.uploader.upload(dataURI, {
      folder: "el-club-pintura/productos",
      resource_type: "auto",
    });

    res
      .status(200)
      .json({ message: "Imagen procesada", imageUrl: uploadResult.secure_url });
  } catch (error) {
    res
      .status(500)
      .json({ error: "Problema al procesar la imagen en la nube." });
  }
};

// ============================================================================
// 🚀 IMPORTACIÓN MASIVA INTELIGENTE: Motor UPSERT Avanzado y Normalización
// ============================================================================
export const importProductsFromExcel = async (req: Request, res: Response) => {
  try {
    const { products, globalMargin, globalIva, supplierName } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res
        .status(400)
        .json({ error: "No se recibieron productos válidos para importar." });
    }

    const margin = Number(globalMargin) || 30.0;
    const iva = Number(globalIva) || 21.0;

    let supplierId: number | null = null;
    let safeBrandName = "General";

    if (supplierName) {
      safeBrandName = String(supplierName).trim();
      let supplier = await prisma.supplier.findFirst({
        where: { companyName: safeBrandName },
      });

      if (!supplier) {
        supplier = await prisma.supplier.create({
          data: {
            companyName: safeBrandName,
            phone: "Sin especificar",
            email: null,
            cuit: null,
            contactName: "Importacion de lista",
            address: "Sin especificar",
            isActive: true,
          },
        });
      }
      supplierId = supplier.id;
    }

    let updatedCount = 0;
    let createdCount = 0;

    // Procesamiento secuencial seguro
    for (const p of products) {
      // 🧠 Pasamos el nombre por el motor de limpieza antes de buscar en BD
      const name = normalizeProductName(String(p.name || ""));
      const costPrice = Number(p.costPrice) || 0;
      if (!name || costPrice <= 0) continue;

      const searchSku = String(p.sku || "").trim();
      let existingProduct = null;

      // 1. Busca por SKU si no es autogenerado
      if (searchSku && !searchSku.startsWith("SKU-AUTO")) {
        existingProduct = await prisma.product.findFirst({
          where: { sku: searchSku, isActive: true },
        });
      }

      // 2. Si no lo encuentra por SKU, busca por Nombre Normalizado Y Marca
      if (!existingProduct) {
        existingProduct = await prisma.product.findFirst({
          where: { name: name, brand: safeBrandName, isActive: true },
        });
      }

      const initialStock = Number(p.stock) || 0;
      const incomingMetadata =
        typeof p.metadata === "object" && p.metadata !== null ? p.metadata : {};

      // 🔄 CAMINO A: ACTUALIZAR PRODUCTO EXISTENTE
      if (existingProduct) {
        const existingMeta =
          typeof existingProduct.metadata === "object" &&
          existingProduct.metadata !== null
            ? existingProduct.metadata
            : {};

        const mergedMetadata = {
          ...existingMeta,
          ...incomingMetadata,
          ...(initialStock > 0 ? { lastImportStock: initialStock } : {}),
        };

        await prisma.product.update({
          where: { id: existingProduct.id },
          data: {
            costPrice: costPrice,
            brand: safeBrandName,
            supplierId:
              supplierId !== null ? supplierId : existingProduct.supplierId,
            metadata: mergedMetadata,
          },
        });

        updatedCount++;
      }
      // 🆕 CAMINO B: CREAR PRODUCTO NUEVO
      else {
        const safeSku = searchSku || `SKU-AUTO-${Date.now()}-${createdCount}`;
        const retailPrice = Math.round(
          costPrice * (1 + margin / 100) * (1 + iva / 100),
        );

        const newMetadata = {
          ...incomingMetadata,
          initialStockImported: initialStock,
          status: "optimal",
        };

        await prisma.product.create({
          data: {
            sku: safeSku,
            name: name, // 🧠 Guardamos el nombre limpio y sin duplicados
            category: "Importación Masiva",
            brand: safeBrandName,
            supplierId: supplierId,
            costPrice: costPrice,
            profitMargin: margin,
            ivaPercentage: iva,
            retailPrice: retailPrice,
            images: [],
            metadata: newMetadata,
          },
        });

        createdCount++;
      }
    }

    res.status(201).json({
      message:
        "Motor ETL UPSERT finalizado. Lista de precios actualizada exitosamente.",
      importedCount: createdCount + updatedCount,
      details: { created: createdCount, updated: updatedCount },
    });
  } catch (error) {
    console.error(
      "Error crítico en el motor ETL de importación masiva:",
      error,
    );
    res.status(500).json({
      error:
        "Fallo estructural al inyectar la lista de precios en la base de datos.",
    });
  }
};

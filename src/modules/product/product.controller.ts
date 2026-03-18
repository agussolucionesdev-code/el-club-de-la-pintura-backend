// Importación de interfaces HTTP y ORM
import { Request, Response } from "express";
import prisma from "../../config/db";
import { Prisma } from "@prisma/client";
// Importación de utilidades de procesamiento y almacenamiento
import * as xlsx from "xlsx";
import cloudinary from "../../config/cloudinary";

// ============================================================================
// LECTURA DE CATÁLOGO: Paginación, búsqueda y filtros
// ============================================================================
export const getProducts = async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = 10, search, category, brand } = req.query;

    const pageNumber = Number(page);
    const pageSize = Number(limit);
    const skip = (pageNumber - 1) * pageSize;

    // INYECCIÓN DE SEGURIDAD: Solo mostramos productos activos en el catálogo
    const whereClause: any = { isActive: true };

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
        // INYECCIÓN RELACIONAL: Adjuntamos los datos del proveedor para la vista del catálogo
        include: {
          supplier: {
            select: { id: true, companyName: true },
          },
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
export const createProduct = async (req: Request, res: Response) => {
  try {
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
      status,
      metadata: reqMetadata,
      ...extraData
    } = req.body;

    if (!sku || !name || !brand || !category) {
      return res.status(400).json({
        error: "Los campos sku, name, brand y category son requeridos.",
      });
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

    // Aplanamiento estructural: Consolidamos stock y metadata
    const flatMetadata = {
      ...(reqMetadata || {}),
      ...(stock !== undefined && {
        stock: Number(stock),
        initialStockImported: Number(stock),
      }),
      ...(status && { status }),
      ...extraData,
    };

    const newProduct = await prisma.product.create({
      data: {
        sku,
        barcode: barcode || null,
        name,
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
        images: images || [], // Blindaje de array
        supplierId: supplierId ? Number(supplierId) : null,
        metadata: Object.keys(flatMetadata).length > 0 ? flatMetadata : null,
      },
    });

    res.status(201).json(newProduct);
  } catch (error) {
    console.error("Error al crear el producto:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al registrar el producto." });
  }
};

// ============================================================================
// ACTUALIZACIÓN: Modificación de producto existente
// ============================================================================
export const updateProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
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
      status,
      metadata: reqMetadata,
      ...extraData
    } = req.body;

    const activeProduct = await prisma.product.findFirst({
      where: { id: Number(id), isActive: true },
    });

    if (!activeProduct)
      return res
        .status(404)
        .json({ error: "El producto no existe o fue archivado." });

    const flatMetadata = {
      ...(reqMetadata || {}),
      ...(stock !== undefined && {
        stock: Number(stock),
        initialStockImported: Number(stock),
      }),
      ...(status && { status }),
      ...extraData,
    };

    const updatedProduct = await prisma.product.update({
      where: { id: Number(id) },
      data: {
        sku,
        barcode: barcode || null,
        name,
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
        metadata: Object.keys(flatMetadata).length > 0 ? flatMetadata : null,
      },
    });

    res.status(200).json(updatedProduct);
  } catch (error) {
    console.error("Error al actualizar el producto:", error);
    res.status(500).json({ error: "No se pudo actualizar el producto." });
  }
};

// ============================================================================
// ELIMINACIÓN SEGURA: Baja lógica del producto
// ============================================================================
export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.product.update({
      where: { id: Number(id) },
      data: { isActive: false },
    });
    res
      .status(200)
      .json({ message: "Producto retirado del catálogo activo exitosamente." });
  } catch (error) {
    res.status(500).json({ error: "No se pudo archivar el producto." });
  }
};

// ============================================================================
// ALOJAMIENTO CLOUD: Subida de imagen a Cloudinary
// ============================================================================
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
// IMPORTACIÓN MASIVA: Procesamiento seguro de Excel/CSV (MOTOR UPSERT 2.0)
// ============================================================================
export const importProductsFromExcel = async (req: Request, res: Response) => {
  try {
    if (!req.file)
      return res
        .status(400)
        .json({ error: "Aduana rechazada: No hay archivo Excel." });

    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName)
      return res
        .status(400)
        .json({ error: "El Excel no contiene hojas legibles." });

    const sheet = workbook.Sheets[sheetName];
    if (!sheet)
      return res
        .status(400)
        .json({ error: "La hoja de cálculo está corrupta." });

    const rawProducts = xlsx.utils.sheet_to_json<any>(sheet as xlsx.WorkSheet);
    if (rawProducts.length === 0)
      return res.status(400).json({ error: "El Excel está vacío." });

    const parseNumber = (val: any): number => {
      if (val === undefined || val === null || val === "") return 0;
      const num = Number(String(val).replace(/[^0-9.-]+/g, ""));
      return isNaN(num) ? 0 : num;
    };

    const productsToProcess = rawProducts.map((row) => {
      const parsedStock = parseNumber(row.stock || row.cantidad || row.STOCK);
      const rawBarcode = row.barcode || row.codigo_barras || row.BARCODE;
      const cleanBarcode = rawBarcode ? String(rawBarcode).trim() : null;

      return {
        sku: String(
          row.sku ||
            row.codigo_interno ||
            row.SKU ||
            `SKU-AUTO-${Math.floor(Math.random() * 10000)}`,
        ).trim(),
        barcode: cleanBarcode === "" ? null : cleanBarcode,
        name: String(
          row.name || row.nombre || row.NAME || "Producto Genérico",
        ).trim(),
        brand: String(row.brand || row.marca || row.SUPPLIER || "S/M").trim(),
        category: String(
          row.category || row.categoria || row.CATEGORY || "General",
        ).trim(),
        description:
          row.description || row.descripcion || row.DESCRIPTION
            ? String(row.description || row.descripcion || row.DESCRIPTION)
            : null,
        costPrice: parseNumber(row.costPrice || row.costo || row.COST_PRICE),
        retailPrice: parseNumber(
          row.retailPrice ||
            row.precio_minorista ||
            row.precio ||
            row.PRICE ||
            row.RETAIL_PRICE,
        ),
        wholesalePrice: parseNumber(row.wholesalePrice || row.precio_mayorista),
        ivaPercentage: parseNumber(row.ivaPercentage || row.iva) || 21.0,
        metadata: { initialStockImported: parsedStock },
        color: row.color || row.COLOR ? String(row.color || row.COLOR) : null,
        finish:
          row.finish || row.acabado ? String(row.finish || row.acabado) : null,
        volume: parseNumber(row.volume || row.volumen) || null,
        volumeUnit:
          row.volumeUnit || row.unidad_volumen
            ? String(row.volumeUnit || row.unidad_volumen)
            : null,
        indoorOutdoor:
          row.indoorOutdoor !== undefined ? Boolean(row.indoorOutdoor) : true,
        baseType:
          row.baseType || row.tipo_base
            ? String(row.baseType || row.tipo_base)
            : null,
        supplierId: parseNumber(row.supplierId || row.proveedor_id) || null,
        isActive: true,
        images: [],
        // ¡NUEVO!: Extraemos la cantidad para inyectarla en la Sucursal
        initialStockQuantity: parsedStock,
      };
    });

    const validProducts = productsToProcess.filter(
      (p) => p.sku !== "" && p.name !== "",
    );

    // Iniciamos la transacción con 60 SEGUNDOS de tiempo, porque ahora hará doble escritura
    await prisma.$transaction(
      async (tx) => {
        // Usamos for...of para procesar fila por fila de forma estructurada
        for (const p of validProducts) {
          const { metadata, images, initialStockQuantity, ...updateData } = p;

          // 1. Guardamos la identidad en el Catálogo (Tabla Product)
          const savedProduct = await tx.product.upsert({
            where: { sku: p.sku },
            update: updateData,
            create: { ...updateData, metadata, images: [] },
          });

          // 2. INYECCIÓN FÍSICA: Guardamos la cantidad en la Sucursal Principal (Tabla Stock)
          await tx.stock.upsert({
            where: {
              productId_branchId: {
                productId: savedProduct.id,
                branchId: 1, // Por defecto al importar, va a la sucursal matriz (ID 1)
              },
            },
            update: { quantity: initialStockQuantity }, // Si ya existe, pisamos la cantidad con la del Excel
            create: {
              productId: savedProduct.id,
              branchId: 1,
              quantity: initialStockQuantity,
              minStock: 5,
            },
          });
        }
      },
      {
        maxWait: 15000,
        timeout: 60000, // 60 segundos de paciencia para Prisma
      },
    );

    res.status(201).json({
      message:
        "Proceso de actualización masiva y sincronización de stock finalizado exitosamente.",
      recordsFound: rawProducts.length,
      importedCount: validProducts.length,
    });
  } catch (error) {
    console.error("Error crítico en el motor de importación masiva:", error);
    res.status(500).json({
      error:
        "Fallo estructural en la base de datos (Posible duplicidad de Códigos de Barra).",
    });
  }
};

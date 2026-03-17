import { Request, Response } from "express";
import prisma from "../../config/db";
import * as xlsx from "xlsx";
import cloudinary from "../../config/cloudinary";
import { Prisma } from "@prisma/client";

// Obtención del catálogo de productos con paginación, búsqueda, filtros dinámicos y relación de proveedor
export const getProducts = async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = 10, search, category, brand } = req.query;

    const pageNumber = Number(page);
    const pageSize = Number(limit);
    const skip = (pageNumber - 1) * pageSize;

    // INYECCIÓN DE SEGURIDAD: Solo mostramos productos activos en el catálogo
    const whereClause: any = { isActive: true };

    if (category) {
      whereClause.category = String(category);
    }

    if (brand) {
      whereClause.brand = String(brand);
    }

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

// Creación de un nuevo producto en el catálogo central
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
      // Extracción explícita para evitar anidamiento doble
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
    if (existingSku) {
      return res
        .status(400)
        .json({ error: "El SKU ingresado ya se encuentra registrado." });
    }

    if (barcode) {
      const existingBarcode = await prisma.product.findUnique({
        where: { barcode },
      });
      if (existingBarcode) {
        return res.status(400).json({
          error: "El código de barras ingresado ya se encuentra registrado.",
        });
      }
    }

    // Aplanamiento estructural: Consolidamos stock y metadata en un solo nivel
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
        images,
        supplierId: supplierId ? Number(supplierId) : null,
        // Guardado de metadatos limpios
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

// Actualización de un producto existente
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
      // Extracción explícita para evitar anidamiento doble
      stock,
      status,
      metadata: reqMetadata,
      ...extraData
    } = req.body;

    const activeProduct = await prisma.product.findFirst({
      where: { id: Number(id), isActive: true },
    });

    if (!activeProduct) {
      return res
        .status(404)
        .json({ error: "El producto no existe o se encuentra archivado." });
    }

    // Aplanamiento estructural: Sincronización para vista Frontend
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
        images,
        supplierId: supplierId ? Number(supplierId) : null,
        // Inyección de metadatos aplanados
        metadata: Object.keys(flatMetadata).length > 0 ? flatMetadata : null,
      },
    });

    res.status(200).json(updatedProduct);
  } catch (error) {
    console.error("Error al actualizar el producto:", error);
    res.status(500).json({
      error:
        "No se pudo actualizar el producto. Verifique el ID o la unicidad de las claves.",
    });
  }
};

// ELIMINACIÓN SEGURA: Baja lógica del producto
export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.product.update({
      where: { id: Number(id) },
      data: { isActive: false },
    });

    res.status(200).json({
      message:
        "Producto retirado del catálogo activo exitosamente. El historial de ventas está a salvo.",
    });
  } catch (error) {
    console.error("Error al retirar el producto:", error);
    res
      .status(500)
      .json({ error: "No se pudo archivar el producto. Verifique el ID." });
  }
};

// Subida de imagen a la nube
export const uploadProductImage = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No se proporcionó ningún archivo de imagen." });
    }

    const b64 = Buffer.from(req.file.buffer).toString("base64");
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    const uploadResult = await cloudinary.uploader.upload(dataURI, {
      folder: "el-club-pintura/productos",
      resource_type: "auto",
    });

    res.status(200).json({
      message: "Imagen procesada y alojada exitosamente.",
      imageUrl: uploadResult.secure_url,
    });
  } catch (error) {
    console.error("Error en el servicio de almacenamiento:", error);
    res.status(500).json({
      error:
        "Hubo un problema al procesar la imagen en el servidor en la nube.",
    });
  }
};

// Importación masiva de productos vía hoja de cálculo (Excel/CSV)
export const importProductsFromExcel = async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "Aduana rechazada: No se adjuntó ningún archivo Excel.",
      });
    }

    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];

    if (!sheetName) {
      return res.status(400).json({
        error:
          "Estructura inválida: El archivo Excel no contiene hojas legibles.",
      });
    }

    const sheet = workbook.Sheets[sheetName];

    if (!sheet) {
      return res.status(400).json({
        error:
          "Error de lectura: La hoja de cálculo está corrupta o es inaccesible.",
      });
    }

    const rawProducts = xlsx.utils.sheet_to_json<any>(sheet);

    if (rawProducts.length === 0) {
      return res.status(400).json({
        error:
          "El archivo Excel proporcionado no contiene datos en sus celdas.",
      });
    }

    const productsToInsert = rawProducts.map((row) => ({
      sku: String(row.sku || row.codigo_interno || row.SKU || ""),
      barcode:
        row.barcode || row.codigo_barras || row.BARCODE
          ? String(row.barcode || row.codigo_barras || row.BARCODE)
          : null,
      name: String(row.name || row.nombre || row.NAME || ""),
      brand: String(row.brand || row.marca || row.SUPPLIER || ""),
      category: String(row.category || row.categoria || row.CATEGORY || ""),
      description:
        row.description || row.descripcion || row.DESCRIPTION || null,

      costPrice:
        row.costPrice || row.costo ? Number(row.costPrice || row.costo) : null,
      retailPrice:
        row.retailPrice || row.precio_minorista || row.precio || row.PRICE
          ? Number(
              row.retailPrice ||
                row.precio_minorista ||
                row.precio ||
                row.PRICE,
            )
          : null,
      wholesalePrice:
        row.wholesalePrice || row.precio_mayorista
          ? Number(row.wholesalePrice || row.precio_mayorista)
          : null,
      ivaPercentage:
        row.ivaPercentage || row.iva !== undefined
          ? Number(row.ivaPercentage || row.iva)
          : 21.0,

      // SOLUCIÓN ARQUITECTÓNICA: Movemos el Stock a la Metadata sin anidamientos extras
      metadata: {
        initialStockImported:
          row.stock || row.cantidad || row.STOCK !== undefined
            ? Number(row.stock || row.cantidad || row.STOCK)
            : 0,
        stock:
          row.stock || row.cantidad || row.STOCK !== undefined
            ? Number(row.stock || row.cantidad || row.STOCK)
            : 0,
      },

      color: row.color || row.COLOR || null,
      finish: row.finish || row.acabado || null,
      volume:
        row.volume || row.volumen ? Number(row.volume || row.volumen) : null,
      volumeUnit: row.volumeUnit || row.unidad_volumen || null,
      indoorOutdoor:
        row.indoorOutdoor !== undefined ? Boolean(row.indoorOutdoor) : true,
      baseType: row.baseType || row.tipo_base || null,

      supplierId:
        row.supplierId || row.proveedor_id
          ? Number(row.supplierId || row.proveedor_id)
          : null,
      isActive: true,
    }));

    const validProducts = productsToInsert.filter(
      (p) => p.sku !== "" && p.name !== "",
    );
    const skusInExcel = validProducts.map((p) => p.sku);

    const result = await prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        await tx.product.deleteMany({
          where: { sku: { in: skusInExcel } },
        });

        return await tx.product.createMany({
          data: validProducts,
          skipDuplicates: true,
        });
      },
    );

    res.status(201).json({
      message: "Proceso de importación masiva finalizado exitosamente.",
      recordsFound: rawProducts.length,
      recordsInserted: result.count,
    });
  } catch (error) {
    console.error("Error crítico en el motor de importación masiva:", error);
    res.status(500).json({
      error:
        "Fallo estructural al procesar el documento. Verifique el formato Excel/CSV.",
    });
  }
};

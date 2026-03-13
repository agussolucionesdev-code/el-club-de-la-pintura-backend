import { Request, Response } from "express";
import prisma from "../../config/db";
import * as xlsx from "xlsx";
import cloudinary from "../../config/cloudinary";

// Obtención del catálogo de productos con paginación, búsqueda y filtros dinámicos
export const getProducts = async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = 10, search, category, brand } = req.query;

    const pageNumber = Number(page);
    const pageSize = Number(limit);
    const skip = (pageNumber - 1) * pageSize;

    const whereClause: any = {};

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
      // INYECCIÓN FINANCIERA
      costPrice,
      retailPrice,
      wholesalePrice,
      ivaPercentage,
      // --------------------
      color,
      finish,
      volume,
      volumeUnit,
      indoorOutdoor,
      baseType,
      images,
      ...metadata
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

    const newProduct = await prisma.product.create({
      data: {
        sku,
        barcode: barcode || null,
        name,
        brand,
        category,
        description,
        // Almacenamiento numérico seguro de los costos
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
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
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
      ...metadata
    } = req.body;

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
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
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

// Eliminación de un producto del catálogo
export const deleteProduct = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.product.delete({ where: { id: Number(id) } });
    res
      .status(200)
      .json({ message: "Producto eliminado correctamente del catálogo." });
  } catch (error) {
    console.error("Error al eliminar el producto:", error);
    res
      .status(500)
      .json({ error: "No se pudo eliminar el producto. Verifique el ID." });
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
      sku: String(row.sku || row.codigo_interno),
      barcode:
        row.barcode || row.codigo_barras
          ? String(row.barcode || row.codigo_barras)
          : null,
      name: String(row.name || row.nombre),
      brand: String(row.brand || row.marca),
      category: String(row.category || row.categoria),
      description: row.description || row.descripcion || null,

      // EXCEL FINANCIAL MAPPING: Interpreta las columnas financieras de tu Excel si existen
      costPrice:
        row.costPrice || row.costo ? Number(row.costPrice || row.costo) : null,
      retailPrice:
        row.retailPrice || row.precio_minorista || row.precio
          ? Number(row.retailPrice || row.precio_minorista || row.precio)
          : null,
      wholesalePrice:
        row.wholesalePrice || row.precio_mayorista
          ? Number(row.wholesalePrice || row.precio_mayorista)
          : null,
      ivaPercentage:
        row.ivaPercentage || row.iva !== undefined
          ? Number(row.ivaPercentage || row.iva)
          : 21.0,

      color: row.color || null,
      finish: row.finish || row.acabado || null,
      volume:
        row.volume || row.volumen ? Number(row.volume || row.volumen) : null,
      volumeUnit: row.volumeUnit || row.unidad_volumen || null,
      indoorOutdoor:
        row.indoorOutdoor !== undefined ? Boolean(row.indoorOutdoor) : true,
      baseType: row.baseType || row.tipo_base || null,
    }));

    const result = await prisma.product.createMany({
      data: productsToInsert,
      skipDuplicates: true,
    });

    res.status(201).json({
      message: "Proceso de importación masiva finalizado exitosamente.",
      recordsFound: rawProducts.length,
      recordsInserted: result.count,
    });
  } catch (error) {
    console.error("Error crítico en el motor de importación masiva:", error);
    res.status(500).json({
      error:
        "Fallo estructural al procesar el documento. Verifique que el formato sea Excel o CSV válido.",
    });
  }
};

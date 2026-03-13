import { Request, Response } from "express";
import prisma from "../../config/db";
import * as xlsx from "xlsx";
import cloudinary from "../../config/cloudinary";

// Obtención del catálogo completo de productos
// Ejecución de consulta a la base de datos y retorno de registros en formato JSON
export const getProducts = async (req: Request, res: Response) => {
  try {
    // Solicitud de todos los registros de la tabla Product
    const products = await prisma.product.findMany();

    // Emisión de respuesta con código HTTP 200 (Éxito)
    res.status(200).json(products);
  } catch (error) {
    console.error("Error al buscar los productos:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al obtener el catálogo de productos." });
  }
};

// Creación de un nuevo producto en el catálogo central
// Recepción, validación de unicidad y empaquetado dinámico de metadatos (JSON)
export const createProduct = async (req: Request, res: Response) => {
  try {
    // Extracción de campos base y agrupación dinámica del resto de atributos (Rest Operator)
    const {
      barcode,
      name,
      brand,
      category,
      description,
      color,
      finish,
      volume,
      volumeUnit,
      indoorOutdoor,
      baseType,
      images,
      ...metadata // <-- Magia de escalabilidad: Atrapa cualquier campo extra enviado en el JSON
    } = req.body;

    // Validación de campos obligatorios base
    if (!barcode || !name || !brand || !category) {
      return res.status(400).json({
        error: "Los campos barcode, name, brand y category son requeridos.",
      });
    }

    // Verificación de existencia previa del código de barras (Prevención de duplicados)
    const existingProduct = await prisma.product.findUnique({
      where: { barcode },
    });

    if (existingProduct) {
      return res.status(400).json({
        error: "El código de barras ingresado ya se encuentra registrado.",
      });
    }

    // Ejecución de la inserción mediante Prisma con inyección de atributos dinámicos
    const newProduct = await prisma.product.create({
      data: {
        barcode,
        name,
        brand,
        category,
        description,
        color,
        finish,
        volume,
        volumeUnit,
        indoorOutdoor,
        baseType,
        images,
        // Si hay campos extra, los guarda en la base de datos como un objeto JSON
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
      },
    });

    // Emisión de respuesta exitosa con código HTTP 201 (Creado)
    res.status(201).json(newProduct);
  } catch (error) {
    console.error("Error al crear el producto:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al registrar el producto." });
  }
};

// Actualización de un producto existente
// Identificación del registro por ID y modificación de campos fijos o metadatos dinámicos
export const updateProduct = async (req: Request, res: Response) => {
  try {
    // Extracción del parámetro ID y de los datos del cuerpo
    const { id } = req.params;
    const {
      barcode,
      name,
      brand,
      category,
      description,
      color,
      finish,
      volume,
      volumeUnit,
      indoorOutdoor,
      baseType,
      images,
      ...metadata // <-- Atrapa modificaciones dinámicas
    } = req.body;

    // Ejecución de la actualización en la base de datos
    const updatedProduct = await prisma.product.update({
      where: { id: Number(id) },
      data: {
        barcode,
        name,
        brand,
        category,
        description,
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

    // Emisión de respuesta con los datos actualizados
    res.status(200).json(updatedProduct);
  } catch (error) {
    console.error("Error al actualizar el producto:", error);
    res
      .status(500)
      .json({ error: "No se pudo actualizar el producto. Verifique el ID." });
  }
};

// Eliminación de un producto del catálogo
// Remoción física del registro de la base de datos mediante su identificador
export const deleteProduct = async (req: Request, res: Response) => {
  try {
    // Extracción del parámetro ID de la solicitud
    const { id } = req.params;

    // Ejecución de la eliminación en la base de datos
    await prisma.product.delete({
      where: { id: Number(id) },
    });

    // Emisión de confirmación de eliminación exitosa
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
// Intercepción de archivo en memoria, conversión a Base64 y transmisión a Cloudinary
export const uploadProductImage = async (req: Request, res: Response) => {
  try {
    // Validación de existencia de archivo adjunto
    if (!req.file) {
      return res
        .status(400)
        .json({ error: "No se proporcionó ningún archivo de imagen." });
    }

    // Conversión de Buffer a Base64 para transmisión segura
    const b64 = Buffer.from(req.file.buffer).toString("base64");
    const dataURI = `data:${req.file.mimetype};base64,${b64}`;

    // Ejecución de carga en Cloudinary
    const uploadResult = await cloudinary.uploader.upload(dataURI, {
      folder: "el-club-pintura/productos", // Organización automática en carpetas en la nube
      resource_type: "auto",
    });

    // Emisión de respuesta con la URL pública generada
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
// Lectura directa en memoria (Buffer), parseo de filas y carga transaccional optimizada
export const importProductsFromExcel = async (req: Request, res: Response) => {
  try {
    // Validación de seguridad: Verificación de existencia del archivo en la petición
    if (!req.file) {
      return res.status(400).json({
        error: "Aduana rechazada: No se adjuntó ningún archivo Excel.",
      });
    }

    // Lectura del archivo directamente desde la memoria RAM para máxima velocidad
    const workbook = xlsx.read(req.file.buffer, { type: "buffer" });

    // Selección de la primera hoja de cálculo del documento
    const sheetName = workbook.SheetNames[0];

    // BARRERA DE SEGURIDAD 1 (Solución a ts(2538))
    // Verifica que el archivo tenga al menos una hoja válida antes de indexar
    if (!sheetName) {
      return res.status(400).json({
        error:
          "Estructura inválida: El archivo Excel no contiene hojas legibles.",
      });
    }

    const sheet = workbook.Sheets[sheetName];

    // BARRERA DE SEGURIDAD 2 (Solución a ts(2345))
    // Verifica que la hoja exista físicamente en la memoria antes de parsearla
    if (!sheet) {
      return res.status(400).json({
        error:
          "Error de lectura: La hoja de cálculo está corrupta o es inaccesible.",
      });
    }

    // Conversión estructural: De celdas de Excel a un arreglo de objetos JSON
    const rawProducts = xlsx.utils.sheet_to_json<any>(sheet);

    // Barrera de validación por archivo vacío
    if (rawProducts.length === 0) {
      return res.status(400).json({
        error:
          "El archivo Excel proporcionado no contiene datos en sus celdas.",
      });
    }

    // Mapeo y estandarización de columnas
    // Se adaptan posibles nombres de columnas en español al esquema estricto de Prisma
    const productsToInsert = rawProducts.map((row) => ({
      barcode: String(row.barcode || row.codigo_barras),
      name: String(row.name || row.nombre),
      brand: String(row.brand || row.marca),
      category: String(row.category || row.categoria),
      description: row.description || row.descripcion || null,
      color: row.color || null,
      finish: row.finish || row.acabado || null,
      volume:
        row.volume || row.volumen ? Number(row.volume || row.volumen) : null,
      volumeUnit: row.volumeUnit || row.unidad_volumen || null,
      indoorOutdoor:
        row.indoorOutdoor !== undefined ? Boolean(row.indoorOutdoor) : true,
      baseType: row.baseType || row.tipo_base || null,
    }));

    // Ejecución de Inserción Masiva (Bulk Insert)
    const result = await prisma.product.createMany({
      data: productsToInsert,
      skipDuplicates: true, // Arquitectura robusta: Ignora registros que ya existan para evitar colapso de lote
    });

    // Emisión de comprobante de auditoría de la operación
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

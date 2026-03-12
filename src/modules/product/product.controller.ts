import { Request, Response } from "express";
import prisma from "../../config/db";
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
// Recepción, validación de unicidad y persistencia de datos
export const createProduct = async (req: Request, res: Response) => {
  try {
    // Extracción de campos desde el cuerpo de la solicitud
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

    // Ejecución de la inserción mediante Prisma
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
// Identificación del registro por ID y modificación de campos específicos
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

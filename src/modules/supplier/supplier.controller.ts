import { Request, Response } from "express";
import prisma from "../../config/db";

// Obtención del listado de proveedores activos
export const getSuppliers = async (req: Request, res: Response) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      where: { isActive: true }, // Solo traemos los que no fueron dados de baja
      orderBy: { companyName: "asc" },
    });
    res.status(200).json(suppliers);
  } catch (error) {
    console.error("Error retrieving suppliers:", error);
    res
      .status(500)
      .json({ error: "Fallo al obtener el directorio de proveedores." });
  }
};

// Registro de una nueva empresa proveedora o corredor
export const createSupplier = async (req: Request, res: Response) => {
  try {
    const { companyName, cuit, contactName, phone, email, address } = req.body;

    // Prevención de duplicados por CUIT
    if (cuit) {
      const existingSupplier = await prisma.supplier.findUnique({
        where: { cuit },
      });
      if (existingSupplier) {
        return res
          .status(400)
          .json({ error: "Ya existe un proveedor registrado con este CUIT." });
      }
    }

    // SANITIZACIÓN: Limpiamos el string del teléfono para asegurar la compatibilidad con la API de WhatsApp
    const cleanPhone = phone.replace(/[\s\-\(\)]/g, "");

    const newSupplier = await prisma.supplier.create({
      data: {
        companyName,
        cuit: cuit || null,
        contactName: contactName || null,
        phone: cleanPhone,
        email: email || null,
        address: address || null,
      },
    });

    res.status(201).json({
      message:
        "Proveedor registrado exitosamente. Enlace de WhatsApp preparado.",
      supplier: newSupplier,
    });
  } catch (error) {
    console.error("Error creating supplier:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al registrar el proveedor." });
  }
};

// Actualización de datos de contacto o razón social
export const updateSupplier = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { companyName, cuit, contactName, phone, email, address } = req.body;

    const cleanPhone = phone ? phone.replace(/[\s\-\(\)]/g, "") : undefined;

    const updatedSupplier = await prisma.supplier.update({
      where: { id: Number(id) },
      data: {
        companyName,
        cuit,
        contactName,
        phone: cleanPhone,
        email,
        address,
      },
    });

    res.status(200).json(updatedSupplier);
  } catch (error) {
    console.error("Error updating supplier:", error);
    res
      .status(500)
      .json({ error: "No se pudo actualizar la ficha del proveedor." });
  }
};

// Borrado Lógico (Soft Delete) para proteger la integridad relacional e histórica
export const deleteSupplier = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    await prisma.supplier.update({
      where: { id: Number(id) },
      data: { isActive: false },
    });

    res.status(200).json({
      message: "Proveedor dado de baja del sistema operativo exitosamente.",
    });
  } catch (error) {
    console.error("Error deactivating supplier:", error);
    res
      .status(500)
      .json({ error: "No se pudo procesar la baja del proveedor." });
  }
};

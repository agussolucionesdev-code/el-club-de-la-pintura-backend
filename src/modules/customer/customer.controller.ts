import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// LECTURA: Obtener el Directorio Comercial (Solo clientes activos)
// ============================================================================
export const getCustomers = async (req: Request, res: Response) => {
  try {
    const customers = await prisma.customer.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      // Traemos un resumen de sus saldos pendientes para mostrar en el Directorio
      include: {
        sales: {
          where: { status: { in: ["PENDING", "PARTIAL"] } },
          select: { balance: true },
        },
      },
    });

    // Mapeo inteligente para saber si el cliente tiene deuda viva
    const directory = customers.map((c) => {
      const activeDebt = c.sales.reduce((sum, sale) => sum + sale.balance, 0);
      return {
        ...c,
        sales: undefined, // Limpiamos la respuesta cruda
        activeDebt, // Inyectamos la deuda calculada
      };
    });

    res.status(200).json({
      message: "Directorio de clientes recuperado con éxito.",
      data: directory,
    });
  } catch (error: unknown) {
    res
      .status(500)
      .json({ error: "Fallo crítico al cargar la cartera de clientes." });
  }
};

// ============================================================================
// ALTA: Registrar un nuevo Cliente/Contratista
// ============================================================================
export const createCustomer = async (req: Request, res: Response) => {
  try {
    const { name, document, type, phone, email, address } = req.body;

    // 🛡️ BLINDAJE: Evitar CUITs o DNIs duplicados
    if (document && document.trim() !== "") {
      const existingCustomer = await prisma.customer.findUnique({
        where: { document: document.trim() },
      });

      if (existingCustomer) {
        throw new Error(
          `Operación rechazada: Ya existe un perfil registrado con el documento/CUIT ${document}.`,
        );
      }
    }

    const newCustomer = await prisma.customer.create({
      data: {
        name,
        document: document || null,
        type: type || "CONSUMER",
        phone,
        email,
        address,
      },
    });

    res.status(201).json({
      message: "Perfil comercial incorporado al directorio exitosamente.",
      data: newCustomer,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Error al registrar el perfil comercial.";
    res.status(400).json({ error: errorMsg });
  }
};

// ============================================================================
// MODIFICACIÓN: Actualizar datos de contacto o perfil
// ============================================================================
export const updateCustomer = async (req: Request, res: Response) => {
  try {
    const customerId = Number(req.params.id);
    const data = req.body;

    // Si intenta cambiar el documento, verificamos que no pise a otro
    if (data.document) {
      const existing = await prisma.customer.findFirst({
        where: {
          document: data.document,
          id: { not: customerId },
        },
      });
      if (existing)
        throw new Error(
          "El Documento/CUIT ingresado ya pertenece a otro cliente.",
        );
    }

    const updatedCustomer = await prisma.customer.update({
      where: { id: customerId },
      data,
    });

    res.status(200).json({
      message: "Ficha del cliente actualizada correctamente.",
      data: updatedCustomer,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Fallo al actualizar el perfil.";
    res.status(400).json({ error: errorMsg });
  }
};

// ============================================================================
// BAJA LÓGICA (Soft Delete): Archivar cliente sin romper el historial contable
// ============================================================================
export const deleteCustomer = async (req: Request, res: Response) => {
  try {
    const customerId = Number(req.params.id);

    // Verificamos si tiene deuda pendiente antes de borrarlo
    const pendingSales = await prisma.sale.findFirst({
      where: { customerId, status: { in: ["PENDING", "PARTIAL"] } },
    });

    if (pendingSales) {
      throw new Error(
        "Bloqueo de Seguridad: No se puede archivar un cliente que mantiene saldos pendientes de pago.",
      );
    }

    await prisma.customer.update({
      where: { id: customerId },
      data: { isActive: false },
    });

    res
      .status(200)
      .json({ message: "Perfil comercial archivado de forma segura." });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Error al archivar el cliente.";
    res.status(400).json({ error: errorMsg });
  }
};

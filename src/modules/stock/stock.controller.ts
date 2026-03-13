import { Request, Response } from "express";
import prisma from "../../config/db";

// Obtención del inventario físico por sucursal
export const getStockByBranch = async (req: Request, res: Response) => {
  try {
    const { branchId } = req.params;

    const stockList = await prisma.stock.findMany({
      where: { branchId: Number(branchId) },
      include: {
        product: {
          select: { name: true, barcode: true, category: true },
        },
      },
    });

    res.status(200).json(stockList);
  } catch (error) {
    console.error("Error al obtener el inventario de la sucursal:", error);
    res.status(500).json({ error: "Hubo un problema al consultar el stock." });
  }
};

// Actualización de inventario con Motor de Auditoría y Trazabilidad (Transacción ACID)
export const updateStock = async (req: Request, res: Response) => {
  try {
    // Extracción del usuario autenticado (Inyectado por el middleware verifyToken)
    const userId = (req as any).user.id;

    // Extracción de parámetros de movimiento y metadatos de auditoría
    const { productId, branchId, quantity, type, reason } = req.body;

    // Validación estricta de variables obligatorias
    if (!productId || !branchId || quantity === undefined) {
      return res.status(400).json({
        error: "Los campos productId, branchId y quantity son obligatorios.",
      });
    }

    // Validación de campos de auditoría obligatorios
    if (!type || !reason) {
      return res.status(400).json({
        error:
          "Auditoría requerida: Debe especificar el tipo de movimiento ('IN', 'OUT', 'ADJUST') y el motivo ('reason').",
      });
    }

    // REGLA DE NEGOCIO 1: Prevención de inconsistencias físicas
    if (Number(quantity) < 0) {
      return res.status(400).json({
        error:
          "Operación rechazada. La cantidad física en stock no puede ser negativa.",
      });
    }

    // EJECUCIÓN TRANSACCIONAL: Se actualiza el stock y se guarda el comprobante en la misma operación
    // Si una de las dos falla, se revierte todo para mantener la integridad de la base de datos
    const [stockRecord, movementRecord] = await prisma.$transaction([
      // 1. Operación de actualización de stock físico
      prisma.stock.upsert({
        where: {
          productId_branchId: {
            productId: Number(productId),
            branchId: Number(branchId),
          },
        },
        update: { quantity: Number(quantity) },
        create: {
          productId: Number(productId),
          branchId: Number(branchId),
          quantity: Number(quantity),
        },
        include: { product: true },
      }),

      // 2. Operación de registro de auditoría en el Libro Diario Inmutable
      prisma.movement.create({
        data: {
          type: String(type), // Ej: "OUT"
          quantity: Number(quantity),
          reason: String(reason), // Ej: "Retiro de Socio - Facundo"
          productId: Number(productId),
          branchId: Number(branchId),
          userId: Number(userId),
        },
      }),
    ]);

    // REGLA DE NEGOCIO 2 y 3: Motor de Alertas de Reposición
    let alertMessage = null;
    let alertType = "OK";

    if (stockRecord.quantity === 0) {
      alertType = "CRITICAL";
      alertMessage = `ALERTA ROJA: El producto "${stockRecord.product.name}" se ha agotado por completo en esta sucursal.`;
    } else if (stockRecord.quantity <= stockRecord.minStock) {
      alertType = "WARNING";
      alertMessage = `ALERTA AMARILLA: El producto "${stockRecord.product.name}" ha alcanzado su nivel crítico de stock (${stockRecord.quantity} unidades restantes).`;
    }

    // Emisión de comprobante de la transacción completa
    res.status(200).json({
      message: "Movimiento registrado y auditado exitosamente.",
      inventoryStatus: alertType,
      alert: alertMessage,
      stock: stockRecord,
      auditorReceipt: movementRecord, // Entrega del comprobante fiscal/auditoría en la respuesta
    });
  } catch (error) {
    console.error("Error al actualizar el stock y generar auditoría:", error);
    res.status(500).json({
      error:
        "Hubo un problema crítico al procesar la transacción de mercadería.",
    });
  }
};

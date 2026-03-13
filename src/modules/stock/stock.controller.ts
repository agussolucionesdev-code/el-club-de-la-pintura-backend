import { Request, Response } from "express";
import prisma from "../../config/db";

// Obtención del inventario físico por sucursal
// Consulta relacional para listar los productos disponibles en un local específico
export const getStockByBranch = async (req: Request, res: Response) => {
  try {
    // Extracción del identificador de la sucursal desde los parámetros de la URL
    const { branchId } = req.params;

    // Ejecución de la consulta con inclusión de datos del producto (JOIN relacional)
    const stockList = await prisma.stock.findMany({
      where: { branchId: Number(branchId) },
      include: {
        product: {
          select: { name: true, barcode: true, category: true }, // Optimización de payload
        },
      },
    });

    // Emisión de respuesta exitosa
    res.status(200).json(stockList);
  } catch (error) {
    console.error("Error al obtener el inventario de la sucursal:", error);
    res.status(500).json({ error: "Hubo un problema al consultar el stock." });
  }
};

// Actualización o inicialización de existencias de inventario
// Aplicación de reglas de negocio: Prevención de stock negativo y sistema de alertas tempranas
export const updateStock = async (req: Request, res: Response) => {
  try {
    // Extracción de parámetros de movimiento de mercadería
    const { productId, branchId, quantity } = req.body;

    // Validación estricta de variables obligatorias
    if (!productId || !branchId || quantity === undefined) {
      return res.status(400).json({
        error: "Los campos productId, branchId y quantity son obligatorios.",
      });
    }

    // REGLA DE NEGOCIO 1: Prevención de inconsistencias físicas (Stock Negativo)
    if (Number(quantity) < 0) {
      return res.status(400).json({
        error:
          "Operación rechazada. La cantidad física en stock no puede ser un número negativo.",
      });
    }

    // Ejecución de operación transaccional UPSERT (Update or Insert)
    // Si el producto ya está en la sucursal, actualiza la cantidad. Si es nuevo, lo registra.
    const stockRecord = await prisma.stock.upsert({
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
      include: { product: true }, // Requerido para nombrar al producto en las alertas
    });

    // REGLA DE NEGOCIO 2 y 3: Motor de Alertas de Reposición
    let alertMessage = null;
    let alertType = "OK";

    if (stockRecord.quantity === 0) {
      alertType = "CRITICAL";
      alertMessage = `ALERTA ROJA: El producto "${stockRecord.product.name}" se ha agotado por completo en esta sucursal.`;
    } else if (stockRecord.quantity <= stockRecord.minStock) {
      alertType = "WARNING";
      alertMessage = `ALERTA AMARILLA: El producto "${stockRecord.product.name}" ha alcanzado su nivel crítico de stock (${stockRecord.quantity} unidades restantes). Se requiere reposición.`;
    }

    // Emisión de respuesta estructurada con estado de inventario y notificaciones
    res.status(200).json({
      message: "Movimiento de inventario registrado exitosamente.",
      inventoryStatus: alertType,
      alert: alertMessage,
      data: stockRecord,
    });
  } catch (error) {
    console.error("Error al actualizar el stock:", error);
    res.status(500).json({
      error: "Hubo un problema al procesar el movimiento de mercadería.",
    });
  }
};

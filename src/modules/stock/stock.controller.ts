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
          select: { name: true, sku: true, category: true, costPrice: true },
        },
      },
    });

    res.status(200).json(stockList);
  } catch (error) {
    console.error("Error al obtener el inventario de la sucursal:", error);
    res.status(500).json({ error: "Hubo un problema al consultar el stock." });
  }
};

// Ingreso/Egreso de mercadería con Actualización Automática de Costos (ERP)
export const updateStock = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { productId, branchId, quantity, type, reason, newCostPrice } =
      req.body;

    // EJECUCIÓN TRANSACCIONAL ACID
    const transactionResult = await prisma.$transaction(async (tx) => {
      // 1. Operación de actualización de stock físico
      const stockRecord = await tx.stock.upsert({
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
      });

      // 2. Operación de registro de auditoría en el Libro Diario Inmutable
      const movementRecord = await tx.movement.create({
        data: {
          type: String(type),
          quantity: Number(quantity),
          reason: String(reason),
          productId: Number(productId),
          branchId: Number(branchId),
          userId: Number(userId),
        },
      });

      // 3. NUEVO: MOTOR DE ACTUALIZACIÓN FINANCIERA AUTOMÁTICA
      // Si entró mercadería (IN) y nos declaran un nuevo costo, actualizamos el catálogo central
      let updatedProduct = null;
      if (
        type === "IN" &&
        newCostPrice !== undefined &&
        newCostPrice !== null
      ) {
        updatedProduct = await tx.product.update({
          where: { id: Number(productId) },
          data: { costPrice: Number(newCostPrice) },
        });
      }

      return { stockRecord, movementRecord, updatedProduct };
    });

    // REGLAS DE NEGOCIO: Motor de Alertas de Reposición (Mantenemos tu lógica impecable)
    let alertMessage = null;
    let alertType = "OK";
    const currentStock = transactionResult.stockRecord;

    if (currentStock.quantity === 0) {
      alertType = "CRITICAL";
      alertMessage = `ALERTA ROJA: El producto "${currentStock.product.name}" se ha agotado por completo en esta sucursal.`;
    } else if (currentStock.quantity <= currentStock.minStock) {
      alertType = "WARNING";
      alertMessage = `ALERTA AMARILLA: El producto "${currentStock.product.name}" ha alcanzado su nivel crítico de stock (${currentStock.quantity} unidades restantes).`;
    }

    res.status(200).json({
      message: transactionResult.updatedProduct
        ? "Mercadería ingresada, auditoría generada y Costo Financiero actualizado con éxito."
        : "Movimiento físico registrado y auditado exitosamente.",
      inventoryStatus: alertType,
      alert: alertMessage,
      stock: currentStock,
      auditorReceipt: transactionResult.movementRecord,
      financialUpdate: transactionResult.updatedProduct
        ? "Costo actualizado"
        : "Sin cambios financieros",
    });
  } catch (error) {
    console.error("Error al actualizar el stock y generar auditoría:", error);
    res.status(500).json({
      error:
        "Hubo un problema crítico al procesar la transacción de logística.",
    });
  }
};

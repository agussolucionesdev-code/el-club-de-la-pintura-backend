import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// OBTENER INVENTARIO: Consulta física por sucursal
// ============================================================================
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

// ============================================================================
// MOVIMIENTO DE MERCADERÍA: Ingreso/Egreso con Actualización Automática (ERP)
// ============================================================================
export const updateStock = async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user.id;
    const { productId, branchId, quantity, type, reason, newCostPrice } =
      req.body;

    const transactionResult = await prisma.$transaction(async (tx) => {
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

    // MOTOR DE ALERTAS: Usa los límites dinámicos
    let alertMessage = null;
    let alertType = "OK";
    const currentStock = transactionResult.stockRecord;

    if (currentStock.quantity <= currentStock.criticalStock) {
      alertType = "CRITICAL";
      alertMessage = `ALERTA ROJA: El producto "${currentStock.product.name}" ha entrado en nivel CRÍTICO (${currentStock.quantity} unidades).`;
    } else if (currentStock.quantity <= currentStock.minStock) {
      alertType = "WARNING";
      alertMessage = `ALERTA AMARILLA: El producto "${currentStock.product.name}" ha alcanzado su nivel de ADVERTENCIA (${currentStock.quantity} unidades restantes).`;
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
    res
      .status(500)
      .json({
        error:
          "Hubo un problema crítico al procesar la transacción de logística.",
      });
  }
};

// ============================================================================
// CONFIGURAR SEMÁFORO: Modificar los umbrales de alerta logística
// ============================================================================
export const updateStockThresholds = async (req: Request, res: Response) => {
  try {
    const { productId, branchId, minStock, criticalStock } = req.body;

    // Buscar si el stock existe para actualizarlo
    const existingStock = await prisma.stock.findUnique({
      where: {
        productId_branchId: {
          productId: Number(productId),
          branchId: Number(branchId),
        },
      },
    });

    if (!existingStock) {
      return res
        .status(404)
        .json({
          error:
            "No se encontró un registro de inventario para este producto en la sucursal indicada.",
        });
    }

    const updatedStock = await prisma.stock.update({
      where: { id: existingStock.id },
      data: {
        minStock: Number(minStock),
        criticalStock: Number(criticalStock),
      },
      include: { product: { select: { name: true } } },
    });

    res.status(200).json({
      message: `Semáforo actualizado para ${updatedStock.product.name}. Amarillo: ${updatedStock.minStock} | Rojo: ${updatedStock.criticalStock}.`,
      stock: updatedStock,
    });
  } catch (error) {
    console.error("Error al configurar umbrales de stock:", error);
    res
      .status(500)
      .json({
        error: "Fallo estructural al actualizar el semáforo de inventario.",
      });
  }
};

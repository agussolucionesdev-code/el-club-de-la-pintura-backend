import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// LECTURA DE INVENTARIO: Catálogo Maestro Completo + Stock Cruzado
// ============================================================================
export const getStockByBranch = async (req: Request, res: Response) => {
  try {
    const branchId = Number(req.params.branchId);

    // 1. ESTRATEGIA ERP (LEFT JOIN LOGIC):
    const products = await prisma.product.findMany({
      where: { isActive: true },
      include: {
        stocks: branchId === 0 ? true : { where: { branchId: branchId } },
      },
      orderBy: { name: "asc" },
    });

    // 2. Mapeo estructural para el Frontend
    const inventory = products.map((p) => {
      let totalQuantity = 0;
      let minStock = 5;
      let stockId = Number(`${p.id}999`);

      // BLINDAJE 1: Forzamos matemáticamente a que sea un Array
      const productStocks = Array.isArray(p.stocks) ? p.stocks : [];

      if (productStocks.length > 0) {
        // BLINDAJE 2: Extracción segura para evitar el error 'noUncheckedIndexedAccess'
        const firstStock = productStocks[0];

        if (branchId === 0) {
          // CONSOLIDADO MULTI-SUCURSAL
          totalQuantity = productStocks.reduce((acc, stock) => {
            return acc + (stock?.quantity || 0);
          }, 0);

          if (firstStock) {
            minStock = firstStock.minStock;
            stockId = firstStock.id;
          }
        } else {
          // SUCURSAL INDIVIDUAL
          if (firstStock) {
            totalQuantity = firstStock.quantity;
            minStock = firstStock.minStock;
            stockId = firstStock.id;
          }
        }
      }

      return {
        id: stockId,
        quantity: totalQuantity,
        minStock: minStock,
        productId: p.id,
        branchId: branchId === 0 ? 1 : branchId,
        product: {
          id: p.id,
          name: p.name,
          sku: p.sku,
          barcode: p.barcode,
          category: p.category,
          brand: p.brand,
          retailPrice: p.retailPrice,
          imageUrl: p.images && p.images.length > 0 ? p.images[0] : undefined,
        },
      };
    });

    res.status(200).json({
      message: "Inventario consolidado recuperado exitosamente.",
      data: inventory,
    });
  } catch (error: unknown) {
    console.error("Error en getStockByBranch:", error);
    res.status(500).json({
      error: "Fallo crítico al cruzar el catálogo con el inventario físico.",
    });
  }
};

// ============================================================================
// AJUSTE DE INVENTARIO: Movimientos manuales (Entradas, Salidas, Ajustes)
// ============================================================================
export const updateStock = async (req: Request, res: Response) => {
  try {
    const { productId, branchId, quantity, type, reason } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      const currentStock = await tx.stock.findUnique({
        where: {
          productId_branchId: {
            productId: Number(productId),
            branchId: Number(branchId),
          },
        },
      });

      let newQuantity = Number(quantity);

      if (currentStock) {
        if (type === "ADD")
          newQuantity = currentStock.quantity + Number(quantity);
        if (type === "SUBTRACT") {
          if (currentStock.quantity < Number(quantity)) {
            throw new Error(
              "Operación rechazada: Stock insuficiente para el descuento solicitado.",
            );
          }
          newQuantity = currentStock.quantity - Number(quantity);
        }
      } else {
        if (type === "SUBTRACT") {
          throw new Error(
            "Operación rechazada: El producto no tiene stock registrado para descontar.",
          );
        }
      }

      const updatedStock = await tx.stock.upsert({
        where: {
          productId_branchId: {
            productId: Number(productId),
            branchId: Number(branchId),
          },
        },
        update: { quantity: newQuantity },
        create: {
          productId: Number(productId),
          branchId: Number(branchId),
          quantity: newQuantity,
          minStock: 5,
        },
      });

      await tx.movement.create({
        data: {
          type: type,
          quantity: Number(quantity),
          reason: reason || "Ajuste manual de inventario",
          productId: Number(productId),
          branchId: Number(branchId),
          userId: 1,
        },
      });

      return updatedStock;
    });

    res.status(200).json({
      message: `Stock actualizado con éxito. Razón: ${reason || "Ajuste manual"}`,
      data: result,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Error desconocido";
    res.status(400).json({ error: errorMsg });
  }
};

// ============================================================================
// CONFIGURACIÓN DE ALERTAS: Actualizar el umbral de stock mínimo
// ============================================================================
export const updateStockThresholds = async (req: Request, res: Response) => {
  try {
    const { productId, branchId, minStock } = req.body;

    const updatedThreshold = await prisma.stock.update({
      where: {
        productId_branchId: {
          productId: Number(productId),
          branchId: Number(branchId),
        },
      },
      data: { minStock: Number(minStock) },
    });

    res.status(200).json({
      message: "Umbrales de alerta actualizados.",
      data: updatedThreshold,
    });
  } catch (error: unknown) {
    res
      .status(400)
      .json({ error: "No se pudo actualizar el umbral de stock." });
  }
};

import { Response } from "express";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

const ensureBranchAccess = (
  branchId: number,
  authUser: { role: string; branchIds: number[] },
) => {
  if (authUser.role === "ADMIN") return;

  if (!authUser.branchIds.includes(branchId)) {
    throw new Error("No tienes acceso a la sucursal indicada.");
  }
};

export const getStockByBranch = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.params.branchId);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const stocksFilter =
      branchId === 0
        ? authUser.role === "ADMIN"
          ? true
          : { where: { branchId: { in: authUser.branchIds } } }
        : { where: { branchId } };

    const products = await prisma.product.findMany({
      where: { isActive: true },
      include: {
        stocks: stocksFilter,
      },
      orderBy: { name: "asc" },
    });

    const inventory = products.map((product) => {
      const productStocks = Array.isArray(product.stocks) ? product.stocks : [];
      const firstStock = productStocks[0];

      const quantity =
        branchId === 0
          ? productStocks.reduce((acc, stock) => acc + stock.quantity, 0)
          : firstStock?.quantity ?? 0;

      const minStock = firstStock?.minStock ?? 5;
      const stockId = firstStock?.id ?? Number(`${product.id}999`);

      return {
        id: stockId,
        quantity,
        minStock,
        productId: product.id,
        branchId: branchId === 0 ? 0 : branchId,
        product: {
          id: product.id,
          name: product.name,
          sku: product.sku,
          barcode: product.barcode,
          category: product.category,
          brand: product.brand,
          retailPrice: product.retailPrice,
          imageUrl:
            product.images && product.images.length > 0
              ? product.images[0]
              : undefined,
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
      error: "Fallo critico al cruzar el catalogo con el inventario fisico.",
    });
  }
};

export const updateStock = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { productId, branchId, quantity, type, reason } = req.body;
    const parsedBranchId = Number(branchId);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    ensureBranchAccess(parsedBranchId, authUser);

    const result = await prisma.$transaction(async (tx) => {
      const currentStock = await tx.stock.findUnique({
        where: {
          productId_branchId: {
            productId: Number(productId),
            branchId: parsedBranchId,
          },
        },
      });

      let newQuantity = Number(quantity);

      if (currentStock) {
        if (type === "ADD") {
          newQuantity = currentStock.quantity + Number(quantity);
        }
        if (type === "SUBTRACT") {
          if (currentStock.quantity < Number(quantity)) {
            throw new Error(
              "Operacion rechazada: Stock insuficiente para el descuento solicitado.",
            );
          }
          newQuantity = currentStock.quantity - Number(quantity);
        }
      } else if (type === "SUBTRACT") {
        throw new Error(
          "Operacion rechazada: El producto no tiene stock registrado para descontar.",
        );
      }

      const updatedStock = await tx.stock.upsert({
        where: {
          productId_branchId: {
            productId: Number(productId),
            branchId: parsedBranchId,
          },
        },
        update: { quantity: newQuantity },
        create: {
          productId: Number(productId),
          branchId: parsedBranchId,
          quantity: newQuantity,
          minStock: 5,
        },
      });

      await tx.movement.create({
        data: {
          type,
          quantity: Number(quantity),
          reason: reason || "Ajuste manual de inventario",
          productId: Number(productId),
          branchId: parsedBranchId,
          userId: authUser.id,
        },
      });

      return updatedStock;
    });

    res.status(200).json({
      message: `Stock actualizado con exito. Razon: ${reason || "Ajuste manual"}`,
      data: result,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Error desconocido";
    res.status(400).json({ error: errorMsg });
  }
};

export const transferStockBetweenBranches = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const { productId, fromBranchId, toBranchId, quantity, reason } = req.body;
    const parsedProductId = Number(productId);
    const parsedFromBranchId = Number(fromBranchId);
    const parsedToBranchId = Number(toBranchId);
    const parsedQuantity = Number(quantity);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    if (
      !Number.isInteger(parsedProductId) ||
      !Number.isInteger(parsedFromBranchId) ||
      !Number.isInteger(parsedToBranchId) ||
      !Number.isInteger(parsedQuantity) ||
      parsedProductId <= 0 ||
      parsedFromBranchId <= 0 ||
      parsedToBranchId <= 0 ||
      parsedQuantity <= 0
    ) {
      return res.status(400).json({
        error:
          "Producto, sucursales y cantidad son obligatorios para transferir stock.",
      });
    }

    if (parsedFromBranchId === parsedToBranchId) {
      return res.status(400).json({
        error: "La sucursal de origen y destino deben ser distintas.",
      });
    }

    ensureBranchAccess(parsedFromBranchId, authUser);
    ensureBranchAccess(parsedToBranchId, authUser);

    const result = await prisma.$transaction(async (tx) => {
      const sourceStock = await tx.stock.findUnique({
        where: {
          productId_branchId: {
            productId: parsedProductId,
            branchId: parsedFromBranchId,
          },
        },
      });

      if (!sourceStock || sourceStock.quantity < parsedQuantity) {
        throw new Error("Stock insuficiente en la sucursal de origen.");
      }

      const updatedSource = await tx.stock.update({
        where: { id: sourceStock.id },
        data: { quantity: sourceStock.quantity - parsedQuantity },
      });

      const updatedTarget = await tx.stock.upsert({
        where: {
          productId_branchId: {
            productId: parsedProductId,
            branchId: parsedToBranchId,
          },
        },
        update: { quantity: { increment: parsedQuantity } },
        create: {
          productId: parsedProductId,
          branchId: parsedToBranchId,
          quantity: parsedQuantity,
          minStock: sourceStock.minStock,
          criticalStock: sourceStock.criticalStock,
        },
      });

      const transferReason =
        reason ||
        `Transferencia interna de sucursal ${parsedFromBranchId} a ${parsedToBranchId}`;

      await tx.movement.createMany({
        data: [
          {
            type: "TRANSFER_OUT",
            quantity: parsedQuantity,
            reason: transferReason,
            productId: parsedProductId,
            branchId: parsedFromBranchId,
            userId: authUser.id,
          },
          {
            type: "TRANSFER_IN",
            quantity: parsedQuantity,
            reason: transferReason,
            productId: parsedProductId,
            branchId: parsedToBranchId,
            userId: authUser.id,
          },
        ],
      });

      return { source: updatedSource, target: updatedTarget };
    });

    res.status(201).json({
      message: "Transferencia de stock registrada correctamente.",
      data: result,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo transferir el stock.";
    res.status(400).json({ error: errorMsg });
  }
};

export const updateStockThresholds = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const { productId, branchId, minStock } = req.body;
    const parsedBranchId = Number(branchId);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    ensureBranchAccess(parsedBranchId, authUser);

    const updatedThreshold = await prisma.stock.update({
      where: {
        productId_branchId: {
          productId: Number(productId),
          branchId: parsedBranchId,
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

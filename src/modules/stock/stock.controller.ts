import { Response } from "express";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

class BranchAccessDeniedError extends Error {}

const responseStatusForStockError = (error: unknown) =>
  error instanceof BranchAccessDeniedError ? 403 : 400;

const ensureBranchAccess = (
  branchId: number,
  authUser: { role: string; branchIds: number[] },
) => {
  if (authUser.role === "ADMIN") return;

  if (!authUser.branchIds.includes(branchId)) {
    throw new BranchAccessDeniedError(
      "No tienes acceso a la sucursal indicada.",
    );
  }
};

const resolveBranchScope = (
  branchId: number,
  authUser: { role: string; branchIds: number[] },
) => {
  if (!Number.isInteger(branchId) || branchId < 0) {
    throw new Error("Sucursal invalida.");
  }

  if (branchId === 0) {
    return authUser.role === "ADMIN" ? undefined : { in: authUser.branchIds };
  }

  ensureBranchAccess(branchId, authUser);
  return branchId;
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

export const getStockTransfers = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const branchId = Number(req.query.branchId ?? 0);
    const branchScope = resolveBranchScope(branchId, authUser);
    const transferWhere =
      branchScope === undefined
        ? undefined
        : { OR: [{ fromBranchId: branchScope }, { toBranchId: branchScope }] };

    const transfers = await prisma.stockTransfer.findMany({
      where: transferWhere,
      orderBy: { createdAt: "desc" },
      take: 150,
    });

    const productIds = Array.from(
      new Set(transfers.map((transfer) => transfer.productId)),
    );
    const branchIds = Array.from(
      new Set(
        transfers.flatMap((transfer) => [
          transfer.fromBranchId,
          transfer.toBranchId,
        ]),
      ),
    );

    const [products, branches] = await Promise.all([
      prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, sku: true, brand: true, category: true },
      }),
      prisma.branch.findMany({
        where: { id: { in: branchIds } },
        select: { id: true, name: true },
      }),
    ]);

    const productById = new Map(
      products.map((product) => [product.id, product]),
    );
    const branchById = new Map(branches.map((branch) => [branch.id, branch]));

    res.status(200).json({
      data: transfers.map((transfer) => ({
        ...transfer,
        product: productById.get(transfer.productId) || null,
        fromBranch: branchById.get(transfer.fromBranchId) || null,
        toBranch: branchById.get(transfer.toBranchId) || null,
      })),
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo listar el historial de transferencias.";
    res.status(responseStatusForStockError(error)).json({ error: errorMsg });
  }
};

export const getReorderSuggestions = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const branchId = Number(req.query.branchId ?? 0);
    const branchScope = resolveBranchScope(branchId, authUser);

    const stocks = await prisma.stock.findMany({
      where: {
        ...(branchScope === undefined ? {} : { branchId: branchScope }),
        product: { isActive: true },
      },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            sku: true,
            brand: true,
            category: true,
            costPrice: true,
          },
        },
        branch: { select: { id: true, name: true } },
      },
      orderBy: [{ branchId: "asc" }, { quantity: "asc" }],
    });

    const suggestions = stocks
      .filter((stock) => stock.quantity <= stock.minStock)
      .map((stock) => ({
        id: stock.id,
        productId: stock.productId,
        branchId: stock.branchId,
        quantity: stock.quantity,
        minStock: stock.minStock,
        criticalStock: stock.criticalStock,
        suggestedQuantity: Math.max(stock.minStock * 2 - stock.quantity, 1),
        product: stock.product,
        branch: stock.branch,
      }))
      .sort((a, b) => a.quantity - b.quantity || a.minStock - b.minStock)
      .slice(0, 150);

    res.status(200).json({ data: suggestions });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudieron calcular las sugerencias de reposicion.";
    res.status(responseStatusForStockError(error)).json({ error: errorMsg });
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
    res.status(responseStatusForStockError(error)).json({ error: errorMsg });
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

      const transfer = await tx.stockTransfer.create({
        data: {
          productId: parsedProductId,
          fromBranchId: parsedFromBranchId,
          toBranchId: parsedToBranchId,
          quantity: parsedQuantity,
          reason: transferReason,
          userId: authUser.id,
          status: "COMPLETED",
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: parsedFromBranchId,
          action: "STOCK_TRANSFER_COMPLETED",
          entityType: "StockTransfer",
          entityId: transfer.id,
        },
      });

      return { transfer, source: updatedSource, target: updatedTarget };
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
    res.status(responseStatusForStockError(error)).json({ error: errorMsg });
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
    if (error instanceof BranchAccessDeniedError) {
      return res.status(403).json({ error: error.message });
    }

    res
      .status(400)
      .json({ error: "No se pudo actualizar el umbral de stock." });
  }
};

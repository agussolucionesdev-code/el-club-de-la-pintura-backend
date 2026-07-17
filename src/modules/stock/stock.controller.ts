/**
 * Stock Controller — inventory management per branch.
 *
 * Handles:
 * - Stock level queries (per branch or consolidated)
 * - Manual stock adjustments (IN / OUT / ADJUST) with movement history
 * - Inter-branch stock transfers (requires ADMIN or ENCARGADO)
 * - Alert counts (critical / warning traffic light) for the sidebar badge
 * - Reorder suggestions based on min/critical thresholds
 * - Stock movement history with date and branch filters
 * - Min/critical threshold updates per product/branch
 *
 * Branch access: ADMIN can access any branch or the consolidated view (branchId=0).
 * ENCARGADO/EMPLOYEE are restricted to their own branches.
 *
 * @module stock.controller
 */
import { Response } from "express";
import { logger } from '../../config/logger';
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";
import { parseLocalDate } from "../../utils/date.utils";

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
    if (authUser.role === "ADMIN") return undefined;
    throw new BranchAccessDeniedError(
      "Solo un administrador puede consultar el consolidado de todas las sucursales.",
    );
  }

  ensureBranchAccess(branchId, authUser);
  return branchId;
};

const toPayloadRecord = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {} as Record<string, unknown>;
  }

  return payload as Record<string, unknown>;
};

/**
 * GET /stock/:branchId
 *
 * Returns the current stock levels for all active products in the given branch.
 * Pass `branchId=0` for a consolidated multi-branch view (ADMIN only).
 * Includes product details (name, sku, brand, category) and alert thresholds.
 *
 * @param branchId - Branch ID, or 0 for all branches.
 */
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
      // Shipped alongside minStock: the UI draws three bands (sano / reponer /
      // crítico) and cannot tell the last one apart without this.
      const criticalStock = firstStock?.criticalStock ?? 0;
      const stockId = firstStock?.id ?? Number(`${product.id}999`);

      return {
        id: stockId,
        quantity,
        minStock,
        criticalStock,
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
    logger.error("Error en getStockByBranch:", error);
    res.status(500).json({
      error: "Fallo crítico al cruzar el catálogo con el inventario físico.",
    });
  }
};

/**
 * GET /stock/transfers
 *
 * Returns inter-branch stock transfer records visible to the authenticated user.
 * Each record includes origin branch, destination branch, product, quantity, reason,
 * and the operator who performed it.
 *
 * @query branchId - Filter by branch (source or destination). 0 = all (ADMIN only).
 */
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
    const internalReceipts = await prisma.internalReceipt.findMany({
      where: {
        receiptType: "STOCK_TRANSFER",
        branchId: { in: branchIds },
      },
      select: {
        id: true,
        branchId: true,
        receiptNumber: true,
        payload: true,
      },
    });
    const receiptByTransferId = new Map<
      string,
      { id: string; receiptNumber: string }
    >();

    for (const receipt of internalReceipts) {
      const payload = toPayloadRecord(receipt.payload);
      const stockTransferId = payload.stockTransferId;
      if (stockTransferId) {
        receiptByTransferId.set(`${String(stockTransferId)}:${receipt.branchId}`, {
          id: receipt.id,
          receiptNumber: receipt.receiptNumber,
        });
      }
    }

    res.status(200).json({
      data: transfers.map((transfer) => {
        const preferredBranchId =
          branchId > 0
            ? branchId
            : authUser.role === "ADMIN" ||
                authUser.branchIds.includes(transfer.fromBranchId)
              ? transfer.fromBranchId
              : transfer.toBranchId;
        const internalReceipt =
          receiptByTransferId.get(`${transfer.id}:${preferredBranchId}`) ||
          receiptByTransferId.get(`${transfer.id}:${transfer.fromBranchId}`) ||
          receiptByTransferId.get(`${transfer.id}:${transfer.toBranchId}`);

        return {
          ...transfer,
          product: productById.get(transfer.productId) || null,
          fromBranch: branchById.get(transfer.fromBranchId) || null,
          toBranch: branchById.get(transfer.toBranchId) || null,
          internalReceiptId: internalReceipt?.id || null,
          internalReceiptNumber: internalReceipt?.receiptNumber || null,
        };
      }),
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo listar el historial de transferencias.";
    res.status(responseStatusForStockError(error)).json({ error: errorMsg });
  }
};

/**
 * GET /stock/reorder-suggestions
 *
 * Returns products whose current stock is at or below their minimum threshold,
 * ordered by criticality. Used to generate purchase suggestions.
 *
 * @query branchId - Branch filter (0 = all branches, ADMIN only).
 */
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

/**
 * GET /stock/alert-count
 *
 * Lightweight endpoint that returns only the count of critical and warning stock
 * alerts for the given branch. Designed for the sidebar badge — loads only the
 * three threshold fields (`quantity`, `minStock`, `criticalStock`).
 *
 * @query branchId - Branch filter (0 = all branches, ADMIN only).
 */
export const getStockAlertCount = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autorizado." });

    const branchId = Number(req.query.branchId ?? 0);
    const branchScope = resolveBranchScope(branchId, authUser);

    // Fetch only stock records below the minimum threshold
    const alertStocks = await prisma.stock.findMany({
      where: {
        ...(branchScope === undefined ? {} : { branchId: branchScope }),
        product: { isActive: true },
      },
      select: { quantity: true, minStock: true, criticalStock: true },
    });

    // Filter in JS: Prisma does not support column-to-column comparisons in where clauses
    const atAlert = alertStocks.filter((s) => s.quantity <= s.minStock);
    const critical = atAlert.filter((s) => s.quantity <= s.criticalStock).length;
    const warning = atAlert.length - critical;

    res.status(200).json({ critical, warning, total: atAlert.length });
  } catch (error: unknown) {
    logger.error("Error al obtener conteo de alertas:", error);
    res.status(500).json({ error: "No se pudo obtener el conteo de alertas." });
  }
};

/**
 * POST /stock/adjust
 *
 * Applies a manual stock adjustment for a product in a specific branch.
 * The adjustment is recorded as a `StockMovement` for audit purposes.
 * Supports three operation types:
 * - `IN`     — adds stock (purchase, return)
 * - `OUT`    — removes stock (damage, theft, correction)
 * - `ADJUST` — sets stock to an absolute value (physical count reconciliation)
 *
 * Consolidated view (branchId=0) is blocked — a branch must be specified.
 *
 * @body productId - Product to adjust.
 * @body branchId  - Target branch (must be > 0).
 * @body quantity  - Units to add/remove (or new absolute total for ADJUST).
 * @body type      - `"IN"`, `"OUT"`, or `"ADJUST"`.
 * @body reason    - Mandatory reason for the movement (stored in audit trail).
 */
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

      // Normalize to the canonical movement history type
      const movementType = type === "ADD" ? "IN" : type === "SUBTRACT" ? "OUT" : "ADJUST";

      await tx.movement.create({
        data: {
          type: movementType,
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
      message: `Stock actualizado con éxito. Motivo: ${reason || "Ajuste manual"}`,
      data: result,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Error desconocido";
    res.status(responseStatusForStockError(error)).json({ error: errorMsg });
  }
};

/**
 * POST /stock/transfer
 *
 * Moves stock units of a product from one branch to another in a single atomic
 * transaction. Both the outgoing deduction and incoming addition are recorded as
 * separate `StockMovement` entries with a linked `StockTransfer` record.
 * An internal receipt is created for audit purposes.
 *
 * Requirements: the source branch must have sufficient stock; both branches
 * must exist and differ from each other.
 *
 * @body productId    - Product being transferred.
 * @body fromBranchId - Source branch ID.
 * @body toBranchId   - Destination branch ID.
 * @body quantity     - Units to transfer (must be > 0).
 * @body reason       - Reason for the transfer (stored in audit trail).
 */
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

      const [product, transferBranches] = await Promise.all([
        tx.product.findUnique({
          where: { id: parsedProductId },
          select: { id: true, name: true, sku: true, brand: true, category: true },
        }),
        tx.branch.findMany({
          where: { id: { in: [parsedFromBranchId, parsedToBranchId] } },
          select: { id: true, name: true },
        }),
      ]);
      const branchById = new Map(
        transferBranches.map((branch) => [branch.id, branch]),
      );
      const transferReceiptPayload = {
        stockTransferId: transfer.id,
        productId: parsedProductId,
        productName: product?.name || null,
        sku: product?.sku || null,
        brand: product?.brand || null,
        category: product?.category || null,
        fromBranchId: parsedFromBranchId,
        fromBranchName:
          branchById.get(parsedFromBranchId)?.name ||
          `Sucursal #${parsedFromBranchId}`,
        toBranchId: parsedToBranchId,
        toBranchName:
          branchById.get(parsedToBranchId)?.name ||
          `Sucursal #${parsedToBranchId}`,
        quantity: parsedQuantity,
        reason: transferReason,
        status: transfer.status,
      };
      const originReceipt = await createInternalReceipt(tx, {
        receiptType: "STOCK_TRANSFER",
        branchId: parsedFromBranchId,
        sourceId: transfer.id,
        createdBy: authUser.id,
        payload: {
          ...transferReceiptPayload,
          direction: "OUT",
        },
      });
      const destinationReceipt = await createInternalReceipt(tx, {
        receiptType: "STOCK_TRANSFER",
        branchId: parsedToBranchId,
        sourceId: transfer.id,
        createdBy: authUser.id,
        payload: {
          ...transferReceiptPayload,
          direction: "IN",
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: parsedFromBranchId,
          action: "STOCK_TRANSFER_COMPLETED",
          entityType: "StockTransfer",
          entityId: transfer.id,
          metadata: {
            originInternalReceiptId: originReceipt.id,
            originInternalReceiptNumber: originReceipt.receiptNumber,
            destinationInternalReceiptId: destinationReceipt.id,
            destinationInternalReceiptNumber: destinationReceipt.receiptNumber,
          },
        },
      });

      return {
        transfer: {
          ...transfer,
          internalReceiptId: originReceipt.id,
          internalReceiptNumber: originReceipt.receiptNumber,
        },
        source: updatedSource,
        target: updatedTarget,
        internalReceipts: {
          origin: originReceipt,
          destination: destinationReceipt,
        },
      };
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

/**
 * PATCH /stock/thresholds
 *
 * Updates the `minStock` and/or `criticalStock` alert thresholds for a product
 * in a specific branch. These values drive the stock traffic-light (green/yellow/red)
 * and the sidebar alert badge.
 *
 * @body productId - Product to update.
 * @body branchId  - Target branch.
 * @body minStock  - New minimum stock threshold (warning level).
 */
export const updateStockThresholds = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const { productId, branchId, minStock, criticalStock } = req.body;
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
      data: {
        minStock: Number(minStock),
        ...(criticalStock !== undefined
          ? { criticalStock: Number(criticalStock) }
          : {}),
      },
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

/**
 * GET /stock/movements
 *
 * Returns a paginated stock movement history filtered by branch, product, and/or
 * date range. Each entry includes type (IN/OUT/ADJUST/SALE/TRANSFER), quantity,
 * reason, operator, and timestamp. Date boundaries use `parseLocalDate` to avoid
 * the UTC-midnight off-by-one issue in UTC-3.
 *
 * @query branchId  - Branch filter (0 = all branches, ADMIN only).
 * @query productId - Optional product filter.
 * @query from      - Start date `YYYY-MM-DD` (local time, inclusive).
 * @query to        - End date `YYYY-MM-DD` (local time, inclusive end of day).
 */
export const getStockMovements = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autorizado." });

    const branchId = Number(req.query.branchId ?? 0);
    const productId = req.query.productId
      ? Number(req.query.productId)
      : undefined;
    const fromStr = req.query.from ? String(req.query.from) : undefined;
    const toStr = req.query.to ? String(req.query.to) : undefined;
    const from = fromStr ? parseLocalDate(fromStr) : undefined;
    const to = (() => {
      if (!toStr) return undefined;
      const d = parseLocalDate(toStr);
      d.setHours(23, 59, 59, 999);
      return d;
    })();
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30)));
    const skip = (page - 1) * limit;

    const branchFilter =
      branchId > 0
        ? { branchId }
        : authUser.role === "ADMIN"
          ? {}
          : { branchId: { in: authUser.branchIds } };

    const productFilter = productId ? { productId } : {};
    const dateFilter =
      from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {};

    const where = { ...branchFilter, ...productFilter, ...dateFilter };

    const [movements, total] = await Promise.all([
      prisma.movement.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          product: { select: { name: true, sku: true, brand: true } },
          user: { select: { name: true } },
          branch: { select: { name: true } },
        },
      }),
      prisma.movement.count({ where }),
    ]);

    res.status(200).json({
      message: "Historial de movimientos recuperado.",
      data: movements,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: unknown) {
    logger.error("Error al obtener movimientos de stock:", error);
    res.status(500).json({ error: "No se pudo obtener el historial de movimientos." });
  }
};

/**
 * Purchase Controller — supplier purchase order and goods receipt management.
 *
 * Workflow:
 *  1. Create a purchase order (`createPurchaseOrder`) to record what was ordered
 *     from a supplier, at what unit cost, for which branch.
 *  2. When goods arrive, record a goods receipt (`receivePurchaseReceipt`).
 *     This automatically increments the branch's stock for each received item.
 *
 * A purchase receipt can reference an existing purchase order or stand alone
 * (direct receive without a prior order).
 *
 * @module purchase.controller
 */
import { Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";

interface PurchaseItem {
  productId: number;
  quantity: number;
  unitCost?: number;
}

interface PurchaseReferenceProduct {
  id: number;
  name: string;
  sku: string;
}

interface PurchaseReferenceSnapshot {
  products: PurchaseReferenceProduct[];
  supplier: { id: number; companyName: string } | null;
}

const ensureBranchAccess = (
  branchId: number,
  authUser: { role: string; branchIds: number[] },
) => {
  if (!Number.isInteger(branchId) || branchId <= 0) {
    throw new Error("La sucursal de la compra no es valida.");
  }

  if (authUser.role === "ADMIN") return;
  if (!authUser.branchIds.includes(branchId)) {
    throw new Error("No tienes acceso a la sucursal indicada.");
  }
};

const resolveBranchWhere = (
  branchId: number,
  authUser: { role: string; branchIds: number[] },
) => {
  if (branchId === 0) {
    return authUser.role === "ADMIN" ? undefined : { in: authUser.branchIds };
  }

  ensureBranchAccess(branchId, authUser);
  return branchId;
};

const toJsonPayload = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const parsePurchaseItems = (items: unknown): PurchaseItem[] => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("La compra debe incluir al menos un producto.");
  }

  return items.map((item) => {
    const rawItem = item as Partial<PurchaseItem>;
    const productId = Number(rawItem.productId);
    const quantity = Number(rawItem.quantity);
    const unitCost =
      rawItem.unitCost === undefined ? undefined : Number(rawItem.unitCost);

    if (!Number.isInteger(productId) || productId <= 0) {
      throw new Error("Los items de compra contienen productos invalidos.");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new Error("Los items de compra contienen datos invalidos.");
    }

    if (
      unitCost !== undefined &&
      (!Number.isFinite(unitCost) || unitCost < 0)
    ) {
      throw new Error("El costo unitario de compra no es valido.");
    }

    return { productId, quantity, unitCost };
  });
};

const parseSupplierId = (value: unknown) => {
  if (value === undefined || value === null || value === "") return null;
  const supplierId = Number(value);
  if (!Number.isInteger(supplierId) || supplierId <= 0) {
    throw new Error("El proveedor indicado no es valido.");
  }
  return supplierId;
};

const assertPurchaseReferences = async (
  tx: Prisma.TransactionClient,
  items: PurchaseItem[],
  supplierId: number | null,
): Promise<PurchaseReferenceSnapshot> => {
  const productIds = Array.from(new Set(items.map((item) => item.productId)));
  const existingProducts = await tx.product.findMany({
    where: { id: { in: productIds }, isActive: true },
    select: { id: true, name: true, sku: true },
  });

  if (existingProducts.length !== productIds.length) {
    throw new Error("Uno o mas productos de la compra no existen o no estan activos.");
  }

  let supplier: PurchaseReferenceSnapshot["supplier"] = null;
  if (supplierId) {
    supplier = await tx.supplier.findFirst({
      where: { id: supplierId, isActive: true },
      select: { id: true, companyName: true },
    });

    if (!supplier) {
      throw new Error("El proveedor indicado no existe o esta inactivo.");
    }
  }

  return { products: existingProducts, supplier };
};

const buildPurchaseReceiptPayload = ({
  items,
  references,
  supplierId,
  purchaseOrderId,
  purchaseReceiptId,
  status,
  reason,
}: {
  items: PurchaseItem[];
  references: PurchaseReferenceSnapshot;
  supplierId: number | null;
  purchaseOrderId?: string | null;
  purchaseReceiptId?: string | null;
  status?: string;
  reason?: string;
}) => {
  const productById = new Map(
    references.products.map((product) => [product.id, product]),
  );
  const totalUnits = items.reduce((sum, item) => sum + item.quantity, 0);
  const estimatedTotal = items.reduce(
    (sum, item) => sum + item.quantity * (item.unitCost || 0),
    0,
  );

  return {
    purchaseOrderId,
    purchaseReceiptId,
    supplierId,
    supplierName: references.supplier?.companyName || null,
    status,
    reason,
    itemsCount: items.length,
    totalUnits,
    estimatedTotal,
    items: items.map((item) => {
      const product = productById.get(item.productId);

      return {
        productId: item.productId,
        sku: product?.sku || null,
        productName: product?.name || null,
        quantity: item.quantity,
        unitCost: item.unitCost,
        subtotal: item.quantity * (item.unitCost || 0),
      };
    }),
  };
};

const toPayloadRecord = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {} as Record<string, unknown>;
  }

  return payload as Record<string, unknown>;
};

const attachInternalReceiptRefs = async <T extends { id: string; branchId: number }>(
  records: T[],
  receiptType: "PURCHASE_ORDER" | "PURCHASE_RECEIPT",
  payloadKey: "purchaseOrderId" | "purchaseReceiptId",
) => {
  if (records.length === 0) return records;

  const branchIds = Array.from(new Set(records.map((record) => record.branchId)));
  const internalReceipts = await prisma.internalReceipt.findMany({
    where: {
      branchId: { in: branchIds },
      receiptType,
    },
    select: {
      id: true,
      receiptNumber: true,
      payload: true,
    },
  });

  const receiptBySourceId = new Map<
    string,
    { id: string; receiptNumber: string }
  >();

  for (const receipt of internalReceipts) {
    const payload = toPayloadRecord(receipt.payload);
    const sourceId = payload[payloadKey];
    if (sourceId) {
      receiptBySourceId.set(String(sourceId), {
        id: receipt.id,
        receiptNumber: receipt.receiptNumber,
      });
    }
  }

  return records.map((record) => {
    const internalReceipt = receiptBySourceId.get(record.id);

    return {
      ...record,
      internalReceiptId: internalReceipt?.id || null,
      internalReceiptNumber: internalReceipt?.receiptNumber || null,
    };
  });
};

/**
 * GET /purchases/orders
 *
 * Returns all purchase orders visible to the authenticated user, ordered by
 * creation date descending. Includes items with product details and the supplier.
 *
 * @query branchId - Branch filter (0 = all branches, ADMIN only).
 */
export const getPurchaseOrders = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const branchId = Number(req.query.branchId ?? 0);
    const branchWhere = resolveBranchWhere(branchId, authUser);

    const orders = await prisma.purchaseOrder.findMany({
      where: branchWhere ? { branchId: branchWhere } : undefined,
      orderBy: { createdAt: "desc" },
      take: 150,
    });

    const ordersWithReceipts = await attachInternalReceiptRefs(
      orders,
      "PURCHASE_ORDER",
      "purchaseOrderId",
    );

    res.status(200).json({ data: ordersWithReceipts });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudieron listar las ordenes de compra.";
    res.status(400).json({ error: errorMsg });
  }
};

/**
 * GET /purchases/receipts
 *
 * Returns all goods receipts (received stock) for the given branch, ordered by
 * reception date descending. Includes items and the linked purchase order (if any).
 *
 * @query branchId - Branch filter (0 = all branches, ADMIN only).
 */
export const getPurchaseReceipts = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const branchId = Number(req.query.branchId ?? 0);
    const branchWhere = resolveBranchWhere(branchId, authUser);

    const receipts = await prisma.purchaseReceipt.findMany({
      where: branchWhere ? { branchId: branchWhere } : undefined,
      orderBy: { receivedAt: "desc" },
      take: 150,
    });

    const receiptsWithInternalReceipts = await attachInternalReceiptRefs(
      receipts,
      "PURCHASE_RECEIPT",
      "purchaseReceiptId",
    );

    res.status(200).json({ data: receiptsWithInternalReceipts });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudieron listar las recepciones de compra.";
    res.status(400).json({ error: errorMsg });
  }
};

/**
 * POST /purchases/orders
 *
 * Creates a purchase order for the given branch and supplier. Records
 * the expected items and unit costs. Does NOT modify stock — use
 * `receivePurchaseReceipt` when the goods actually arrive.
 *
 * @body branchId   - Branch placing the order.
 * @body supplierId - Optional supplier ID.
 * @body items      - Array of `{ productId, quantity, unitCost }`.
 */
export const createPurchaseOrder = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.body.branchId);
    const items = parsePurchaseItems(req.body.items);
    const supplierId = parseSupplierId(req.body.supplierId);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    ensureBranchAccess(branchId, authUser);

    const purchaseOrder = await prisma.$transaction(async (tx) => {
      const references = await assertPurchaseReferences(tx, items, supplierId);

      const createdOrder = await tx.purchaseOrder.create({
        data: {
          supplierId,
          branchId,
          status: "DRAFT",
          items: toJsonPayload(items),
          createdBy: authUser.id,
        },
      });

      const internalReceipt = await createInternalReceipt(tx, {
        receiptType: "PURCHASE_ORDER",
        branchId,
        sourceId: createdOrder.id,
        createdBy: authUser.id,
        payload: buildPurchaseReceiptPayload({
          items,
          references,
          supplierId,
          purchaseOrderId: createdOrder.id,
          status: createdOrder.status,
        }),
      });

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId,
          action: "PURCHASE_ORDER_CREATED",
          entityType: "PurchaseOrder",
          entityId: createdOrder.id,
          metadata: toJsonPayload({
            supplierId,
            itemCount: items.length,
            internalReceiptId: internalReceipt.id,
          }),
        },
      });

      return {
        ...createdOrder,
        internalReceiptId: internalReceipt.id,
        internalReceiptNumber: internalReceipt.receiptNumber,
      };
    });

    res.status(201).json({
      message: "Orden de compra registrada correctamente.",
      data: purchaseOrder,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo preparar la orden de compra.";
    res.status(400).json({ error: errorMsg });
  }
};

/**
 * POST /purchases/receipts
 *
 * Records a goods receipt and increments stock for each received item in the
 * target branch. Can be linked to an existing purchase order via `purchaseOrderId`
 * or created as a standalone receipt. Updates product `costPrice` if the received
 * unit cost differs from the current catalog price.
 * Creates an internal receipt for audit purposes.
 *
 * @body branchId         - Branch receiving the goods.
 * @body supplierId       - Optional supplier ID.
 * @body purchaseOrderId  - Optional: link to an existing purchase order.
 * @body items            - Array of `{ productId, quantity, unitCost }`.
 */
export const receivePurchaseReceipt = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.body.branchId);
    const items = parsePurchaseItems(req.body.items);
    const supplierId = parseSupplierId(req.body.supplierId);
    const purchaseOrderId =
      req.body.purchaseOrderId === undefined ||
      req.body.purchaseOrderId === null ||
      req.body.purchaseOrderId === ""
        ? null
        : String(req.body.purchaseOrderId);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    ensureBranchAccess(branchId, authUser);

    const result = await prisma.$transaction(async (tx) => {
      const references = await assertPurchaseReferences(tx, items, supplierId);

      if (purchaseOrderId) {
        const order = await tx.purchaseOrder.findUnique({
          where: { id: purchaseOrderId },
        });

        if (!order || order.branchId !== branchId) {
          throw new Error("La orden de compra no pertenece a la sucursal indicada.");
        }

        if (order.status === "RECEIVED") {
          throw new Error("La orden de compra ya fue recibida previamente.");
        }
      }

      const updatedItems = [];

      const receipt = await tx.purchaseReceipt.create({
        data: {
          purchaseOrderId,
          supplierId,
          branchId,
          items: toJsonPayload(items),
          receivedBy: authUser.id,
        },
      });

      for (const item of items) {
        const updatedStock = await tx.stock.upsert({
          where: {
            productId_branchId: {
              productId: item.productId,
              branchId,
            },
          },
          update: { quantity: { increment: item.quantity } },
          create: {
            productId: item.productId,
            branchId,
            quantity: item.quantity,
            minStock: 5,
          },
        });

        if (item.unitCost !== undefined && item.unitCost >= 0) {
          await tx.product.update({
            where: { id: item.productId },
            data: { costPrice: item.unitCost },
          });
        }

        await tx.movement.create({
          data: {
            type: "PURCHASE",
            quantity: item.quantity,
            reason: req.body.reason || "Recepcion de compra interna",
            productId: item.productId,
            branchId,
            userId: authUser.id,
          },
        });

        updatedItems.push(updatedStock);
      }

      if (purchaseOrderId) {
        await tx.purchaseOrder.update({
          where: { id: purchaseOrderId },
          data: { status: "RECEIVED" },
        });
      }

      const internalReceipt = await createInternalReceipt(tx, {
        receiptType: "PURCHASE_RECEIPT",
        branchId,
        sourceId: receipt.id,
        createdBy: authUser.id,
        payload: buildPurchaseReceiptPayload({
          items,
          references,
          supplierId,
          purchaseOrderId,
          purchaseReceiptId: receipt.id,
          reason: String(req.body.reason || "Recepcion de compra interna"),
          status: "RECEIVED",
        }),
      });

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId,
          action: "PURCHASE_RECEIPT_CREATED",
          entityType: "PurchaseReceipt",
          entityId: receipt.id,
          metadata: toJsonPayload({
            supplierId,
            purchaseOrderId,
            itemCount: items.length,
            internalReceiptId: internalReceipt.id,
          }),
        },
      });

      return {
        receipt: {
          ...receipt,
          internalReceiptId: internalReceipt.id,
          internalReceiptNumber: internalReceipt.receiptNumber,
        },
        updatedStocks: updatedItems,
        internalReceipt,
      };
    });

    res.status(201).json({
      message: "Recepcion de compra registrada y stock actualizado.",
      data: result,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo registrar la recepcion de compra.";
    res.status(400).json({ error: errorMsg });
  }
};

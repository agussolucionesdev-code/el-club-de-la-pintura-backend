import { Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

interface PurchaseItem {
  productId: number;
  quantity: number;
  unitCost?: number;
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
) => {
  const productIds = Array.from(new Set(items.map((item) => item.productId)));
  const existingProducts = await tx.product.findMany({
    where: { id: { in: productIds }, isActive: true },
    select: { id: true },
  });

  if (existingProducts.length !== productIds.length) {
    throw new Error("Uno o mas productos de la compra no existen o no estan activos.");
  }

  if (supplierId) {
    const supplier = await tx.supplier.findFirst({
      where: { id: supplierId, isActive: true },
      select: { id: true },
    });

    if (!supplier) {
      throw new Error("El proveedor indicado no existe o esta inactivo.");
    }
  }
};

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

    res.status(200).json({ data: orders });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudieron listar las ordenes de compra.";
    res.status(400).json({ error: errorMsg });
  }
};

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

    res.status(200).json({ data: receipts });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudieron listar las recepciones de compra.";
    res.status(400).json({ error: errorMsg });
  }
};

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
      await assertPurchaseReferences(tx, items, supplierId);

      const createdOrder = await tx.purchaseOrder.create({
        data: {
          supplierId,
          branchId,
          status: "DRAFT",
          items: toJsonPayload(items),
          createdBy: authUser.id,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId,
          action: "PURCHASE_ORDER_CREATED",
          entityType: "PurchaseOrder",
          entityId: createdOrder.id,
          metadata: toJsonPayload({ supplierId, itemCount: items.length }),
        },
      });

      return createdOrder;
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
      await assertPurchaseReferences(tx, items, supplierId);

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
            type: "PURCHASE_IN",
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
          }),
        },
      });

      return { receipt, updatedStocks: updatedItems };
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

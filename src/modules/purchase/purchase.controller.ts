import { Response } from "express";
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
  if (authUser.role === "ADMIN") return;
  if (!authUser.branchIds.includes(branchId)) {
    throw new Error("No tienes acceso a la sucursal indicada.");
  }
};

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

    if (
      !Number.isInteger(productId) ||
      !Number.isInteger(quantity) ||
      productId <= 0 ||
      quantity <= 0
    ) {
      throw new Error("Los items de compra contienen datos invalidos.");
    }

    return { productId, quantity, unitCost };
  });
};

export const createPurchaseOrder = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.body.branchId);
    const items = parsePurchaseItems(req.body.items);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    ensureBranchAccess(branchId, authUser);

    res.status(201).json({
      message:
        "Orden de compra preparada. La persistencia formal de ordenes queda lista para la migracion ERP.",
      data: {
        id: `PO-DRAFT-${Date.now()}`,
        branchId,
        supplierId: req.body.supplierId ? Number(req.body.supplierId) : null,
        items,
        status: "DRAFT",
        createdAt: new Date().toISOString(),
      },
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

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    ensureBranchAccess(branchId, authUser);

    const result = await prisma.$transaction(async (tx) => {
      const updatedItems = [];

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

      return updatedItems;
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

/**
 * Return Controller — partial and full RMA (Return Merchandise Authorization).
 *
 * A return is NOT the same as a void (cancel). A void removes the sale from financial
 * records. A return acknowledges that goods came back: stock is restored, a credit note
 * is generated (as a Return record), and the customer's credit balance is adjusted
 * if the original sale was on account.
 *
 * All mutations run inside a single Prisma $transaction so stock, credit, and audit
 * records are always consistent — never partially applied.
 */
import { Response } from "express";
import { logger } from "../../config/logger";
import prisma, { PrismaTx } from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";
import { Prisma } from "@prisma/client";

interface ReturnItem {
  saleItemId: number;
  quantity: number;
}

const ensureBranchAccess = (branchId: number, authUser: { role: string; branchIds: number[] }) => {
  if (authUser.role === "ADMIN") return;
  if (!authUser.branchIds.includes(branchId)) {
    throw new Error("No tienes acceso a la sucursal de esta venta.");
  }
};

/**
 * POST /sales/:id/return
 *
 * Creates a partial or full return against a completed sale.
 *
 * Body:
 *   reason   — string, required
 *   items    — [{ saleItemId, quantity }], required, non-empty
 *
 * Side-effects (all in one $transaction):
 *   - Restores stock for each returned item
 *   - Reduces customer credit balance if sale was CREDIT_ACCOUNT / PARTIAL
 *   - Creates a Return record (audit trail + financial document)
 *   - Creates an InternalReceipt of type SALE_REFUND
 */
export const createReturn = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) {
      return res.status(401).json({ error: "No se pudo validar la identidad." });
    }

    const saleId = Number(req.params.id);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({ error: "ID de venta inválido." });
    }

    const { reason, items } = req.body as { reason?: string; items?: ReturnItem[] };

    if (!reason || String(reason).trim().length < 5) {
      return res.status(400).json({ error: "El motivo de la devolución debe tener al menos 5 caracteres." });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Debe indicar al menos un ítem a devolver." });
    }

    // Validate all requested items have positive integer quantities
    for (const item of items) {
      if (!Number.isInteger(item.saleItemId) || item.saleItemId <= 0 ||
          !Number.isInteger(item.quantity) || item.quantity <= 0) {
        return res.status(400).json({
          error: "Cada ítem debe tener un saleItemId y una cantidad positivos.",
        });
      }
    }

    const cleanReason = String(reason).trim().slice(0, 500);

    const result = await prisma.$transaction(async (tx: PrismaTx | Prisma.TransactionClient) => {
      // ── 1. Load the original sale with items, payments, and customer ──────────
      const sale = await tx.sale.findUnique({
        where: { id: saleId },
        include: {
          items: {
            include: { product: { select: { id: true, name: true } } },
          },
          payments: { select: { amount: true, paymentMethod: true } },
          customer: { select: { id: true, name: true } },
        },
      });

      if (!sale) {
        throw new Error("Venta no encontrada.");
      }
      if (sale.status === "CANCELLED") {
        throw new Error("No se puede devolver una venta ya anulada.");
      }

      ensureBranchAccess(sale.branchId, authUser);

      // ── 2a. Load all previous returns to compute already-returned quantities ──
      const previousReturns = await tx.return.findMany({
        where: { saleId },
        select: { items: true },
      });

      // Build a map: saleItemId → total units already returned across all returns
      const alreadyReturned = new Map<number, number>();
      for (const prev of previousReturns) {
        const prevItems = (prev.items ?? []) as { saleItemId: number; quantity: number }[];
        for (const pi of prevItems) {
          alreadyReturned.set(pi.saleItemId, (alreadyReturned.get(pi.saleItemId) ?? 0) + pi.quantity);
        }
      }

      // ── 2b. Validate each requested item against original qty and remaining qty ─
      const returnLineItems: {
        saleItemId: number;
        productId: number;
        productName: string;
        quantity: number;
        refundedUnitPrice: number;
      }[] = [];

      for (const req of items) {
        const originalItem = sale.items.find((i) => i.id === req.saleItemId);
        if (!originalItem) {
          throw new Error(`El ítem ${req.saleItemId} no pertenece a esta venta.`);
        }

        const previouslyReturned = alreadyReturned.get(req.saleItemId) ?? 0;
        const remainingReturnable = originalItem.quantity - previouslyReturned;

        if (req.quantity <= 0) {
          throw new Error(`La cantidad a devolver debe ser positiva.`);
        }
        if (req.quantity > remainingReturnable) {
          throw new Error(
            `No se pueden devolver ${req.quantity} unidades de "${originalItem.product.name}": ` +
            `ya se devolvieron ${previouslyReturned} y la venta original tenía ${originalItem.quantity} ` +
            `(quedan ${remainingReturnable} devolvibles).`,
          );
        }
        returnLineItems.push({
          saleItemId: req.saleItemId,
          productId: originalItem.productId,
          productName: originalItem.product.name,
          quantity: req.quantity,
          refundedUnitPrice: Number(originalItem.unitPrice),
        });
      }

      // ── 3. Calculate total refund amount ──────────────────────────────────────
      const totalRefund = returnLineItems.reduce(
        (sum, item) => sum + item.refundedUnitPrice * item.quantity,
        0,
      );

      // ── 4. Restore stock for each returned item ───────────────────────────────
      for (const item of returnLineItems) {
        await tx.stock.updateMany({
          where: { productId: item.productId, branchId: sale.branchId },
          data: { quantity: { increment: item.quantity } },
        });

        await tx.movement.create({
          data: {
            type: "IN",
            quantity: item.quantity,
            reason: `Devolución RMA #${saleId}: ${cleanReason}`,
            productId: item.productId,
            branchId: sale.branchId,
            userId: authUser.id,
          },
        });
      }

      // ── 5. Reduce customer credit balance if the sale is on account ───────────
      const isCreditSale =
        sale.paymentMethod === "CREDIT_ACCOUNT" ||
        sale.status === "PENDING" ||
        sale.status === "PARTIAL";

      if (isCreditSale && sale.customerId) {
        const newBalance = Math.max(0, Number(sale.balance) - totalRefund);
        await tx.sale.update({
          where: { id: saleId },
          data: {
            balance: newBalance,
            status: newBalance === 0 ? "PAID" : "PARTIAL",
          },
        });
      }

      // ── 6. Create the Return record ───────────────────────────────────────────
      const returnRecord = await tx.return.create({
        data: {
          saleId,
          reason: cleanReason,
          branchId: sale.branchId,
          createdById: authUser.id,
          totalRefund,
          items: returnLineItems as unknown as Prisma.InputJsonValue,
          cashRegisterId: sale.cashRegisterId,
        },
      });

      // ── 7. Internal receipt ───────────────────────────────────────────────────
      await createInternalReceipt(tx, {
        receiptType: "SALE_REFUND",
        branchId: sale.branchId,
        cashRegisterId: sale.cashRegisterId,
        saleId,
        sourceId: returnRecord.id,
        createdBy: authUser.id,
        payload: {
          returnId: returnRecord.id,
          originalSaleId: saleId,
          reason: cleanReason,
          totalRefund,
          items: returnLineItems,
          customer: sale.customer?.name ?? "Consumidor Final",
        },
      });

      return { returnRecord, totalRefund };
    });

    res.status(201).json({
      message: "Devolución registrada correctamente. Stock actualizado.",
      data: {
        returnId: result.returnRecord.id,
        saleId,
        totalRefund: result.totalRefund,
        itemCount: items.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error inesperado en la devolución.";
    logger.error("Error en createReturn:", error);
    res.status(400).json({ error: message });
  }
};

/**
 * GET /sales/:id/returns
 *
 * Lists all returns made against a specific sale.
 */
export const getReturnsBySale = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autenticado." });

    const saleId = Number(req.params.id);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({ error: "ID de venta inválido." });
    }

    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      select: { branchId: true },
    });

    if (!sale) return res.status(404).json({ error: "Venta no encontrada." });
    ensureBranchAccess(sale.branchId, authUser);

    const returns = await prisma.return.findMany({
      where: { saleId },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json({ data: returns });
  } catch (error) {
    logger.error("Error en getReturnsBySale:", error);
    res.status(500).json({ error: "Error al recuperar las devoluciones." });
  }
};

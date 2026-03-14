import { Request, Response } from "express";
import prisma from "../../config/db";

// Process POS Transaction with Accounts Receivable logic
export const processSale = async (req: Request, res: Response) => {
  try {
    const {
      branchId,
      paymentMethod,
      items,
      customerId,
      pickedUpBy,
      amountPaid,
    } = req.body;
    const authUser = (req as any).user;

    // MULTI-BRANCH BARRIER
    if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
      return res.status(403).json({
        error:
          "Brecha de seguridad: Tu perfil operativo no tiene autorización para facturar en esta sucursal.",
      });
    }

    const transactionResult = await prisma.$transaction(async (tx) => {
      let totalAmount = 0;
      const enrichedItems = [];

      // 1. Process items, calculate totals, freeze costs, and deduct physical stock
      for (const item of items) {
        const subtotal = item.quantity * item.unitPrice;
        totalAmount += subtotal;

        const productData = await tx.product.findUnique({
          where: { id: item.productId },
          select: { costPrice: true },
        });

        const currentStock = await tx.stock.findUnique({
          where: {
            productId_branchId: {
              productId: item.productId,
              branchId: branchId,
            },
          },
        });

        if (!currentStock || currentStock.quantity < item.quantity) {
          throw new Error(
            `Inventario insuficiente para el producto ID: ${item.productId}. Venta abortada.`,
          );
        }

        await tx.stock.update({
          where: { id: currentStock.id },
          data: { quantity: { decrement: item.quantity } },
        });

        await tx.movement.create({
          data: {
            type: "OUT",
            quantity: item.quantity,
            reason: `Venta Comercial - Medio: ${paymentMethod}`,
            productId: item.productId,
            branchId: branchId,
            userId: authUser.id,
          },
        });

        enrichedItems.push({
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          unitCost: productData?.costPrice || 0,
          subtotal: item.quantity * item.unitPrice,
        });
      }

      // 2. Financial Debt & Status Calculation
      // If amountPaid is not provided, we assume it's fully paid to maintain backward compatibility
      const actualAmountPaid =
        amountPaid !== undefined ? Number(amountPaid) : totalAmount;
      const balance = totalAmount - actualAmountPaid;

      let status = "PAID";
      if (actualAmountPaid === 0) status = "PENDING";
      else if (balance > 0) status = "PARTIAL";

      // 3. Generate Master Sale Ticket with Debt tracking
      const saleRecord = await tx.sale.create({
        data: {
          totalAmount,
          paymentMethod,
          branchId,
          userId: authUser.id,
          customerId: customerId ? Number(customerId) : null,
          pickedUpBy: pickedUpBy || null,
          status,
          balance,
          items: {
            create: enrichedItems,
          },
        },
        include: { items: true },
      });

      // 4. Register Physical Cash Flow (Only if money actually entered the drawer)
      if (actualAmountPaid > 0) {
        await tx.payment.create({
          data: {
            amount: actualAmountPaid,
            paymentMethod: paymentMethod,
            saleId: saleRecord.id,
            userId: authUser.id,
            branchId: branchId,
          },
        });
      }

      return saleRecord;
    });

    res.status(201).json({
      message: "Transacción comercial y flujo de caja procesados con éxito.",
      ticket: transactionResult,
    });
  } catch (error: any) {
    console.error("Error crítico en el motor transaccional de ventas:", error);
    if (error instanceof Error) {
      return res.status(400).json({ error: error.message });
    }
    res
      .status(500)
      .json({ error: "Fallo estructural al procesar el carrito de compras." });
  }
};

// Retrieve Sales History with Customer details
export const getSales = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;

    const whereClause =
      authUser.role === "ADMIN" ? {} : { branchId: { in: authUser.branchIds } };

    const salesHistory = await prisma.sale.findMany({
      where: whereClause,
      include: {
        user: { select: { name: true, role: true } },
        customer: { select: { name: true, document: true, type: true } }, // NEW: Include Customer info
        items: { include: { product: { select: { name: true, sku: true } } } },
        payments: true, // NEW: Include related payment receipts
      },
      orderBy: { createdAt: "desc" },
    });

    res.status(200).json(salesHistory);
  } catch (error) {
    console.error("Error al obtener el registro de facturación:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al consultar los tickets de venta." });
  }
};

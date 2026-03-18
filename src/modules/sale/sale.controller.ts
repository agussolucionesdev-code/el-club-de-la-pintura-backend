import { Request, Response } from "express";
import prisma from "../../config/db";

export const createSale = async (req: Request, res: Response) => {
  try {
    const {
      branchId,
      userId,
      customerId,
      cashRegisterId,
      items,
      totalAmount,
      paymentMethod,
      status,
    } = req.body;

    const result = await prisma.$transaction(async (tx) => {
      // 1. Validar caja abierta usando el ID que manda el frontend
      const register = await tx.cashRegister.findUnique({
        where: { id: Number(cashRegisterId) },
      });

      if (!register || register.status !== "OPEN") {
        throw new Error("Operación rechazada: La caja debe estar abierta.");
      }

      // 2. Crear Venta
      const newSale = await tx.sale.create({
        data: {
          branchId: Number(branchId),
          userId: Number(userId),
          customerId: customerId ? Number(customerId) : null,
          cashRegisterId: Number(cashRegisterId),
          totalAmount: Number(totalAmount),
          paymentMethod,
          status: status || "PAID",
          items: {
            create: items.map((item: any) => ({
              productId: Number(item.productId),
              quantity: Number(item.quantity),
              unitPrice: Number(item.unitPrice),
              subtotal: Number(item.subtotal),
            })),
          },
        },
      });

      // 3. Descontar Stock (Con Upsert para evitar bloqueos si no hay inventario previo)
      for (const item of items) {
        await tx.stock.upsert({
          where: {
            productId_branchId: {
              productId: Number(item.productId),
              branchId: Number(branchId),
            },
          },
          update: { quantity: { decrement: Number(item.quantity) } },
          create: {
            productId: Number(item.productId),
            branchId: Number(branchId),
            quantity: -Number(item.quantity), // Lo deja en negativo avisando que falta cargar stock
          },
        });
      }
      // 4. Registrar Pago
      await tx.payment.create({
        data: {
          amount: Number(totalAmount),
          paymentMethod: paymentMethod,
          sale: { connect: { id: newSale.id } },
          user: { connect: { id: Number(userId) } },
          branch: { connect: { id: Number(branchId) } },
          cashRegister: { connect: { id: Number(cashRegisterId) } },
        },
      });

      // 5. Actualizar saldo esperado de caja
      await tx.cashRegister.update({
        where: { id: Number(cashRegisterId) },
        data: { expectedBalance: { increment: Number(totalAmount) } },
      });

      return newSale;
    });

    res.status(201).json({
      message: "Transacción comercial completada con éxito.",
      data: result,
    });
  } catch (error: any) {
    console.error("Fallo crítico en transacción de venta:", error.message);
    res
      .status(400)
      .json({ error: "Error en la operación", details: error.message });
  }
};

export const getSales = async (req: Request, res: Response) => {
  try {
    const sales = await prisma.sale.findMany({
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        customer: true,
        user: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    res.status(200).json(sales);
  } catch (error) {
    res.status(500).json({ error: "Error al obtener ventas." });
  }
};

export const getSaleById = async (req: Request, res: Response) => {
  try {
    const sale = await prisma.sale.findUnique({
      where: { id: Number(req.params.id) },
      include: { items: true, customer: true },
    });
    if (!sale) return res.status(404).json({ error: "Venta no encontrada." });
    res.status(200).json(sale);
  } catch (error) {
    res.status(500).json({ error: "Error al obtener la venta." });
  }
};

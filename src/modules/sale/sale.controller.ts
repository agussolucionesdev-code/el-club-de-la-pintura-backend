import { Request, Response } from "express";
import prisma from "../../config/db";

export const processSale = async (req: Request, res: Response) => {
  try {
    const { branchId, paymentMethod, items } = req.body;
    const authUser = (req as any).user;

    // BARRERA MULTI-SUCURSAL
    // Verificamos si el arreglo de permisos del token incluye la sucursal donde quiere facturar
    if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
      return res.status(403).json({
        error:
          "Brecha de seguridad: Tu perfil operativo no tiene autorización para facturar en esta sucursal.",
      });
    }

    const transactionResult = await prisma.$transaction(async (tx) => {
      let totalAmount = 0;

      for (const item of items) {
        const subtotal = item.quantity * item.unitPrice;
        totalAmount += subtotal;

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
      }

      const saleRecord = await tx.sale.create({
        data: {
          totalAmount,
          paymentMethod,
          branchId,
          userId: authUser.id,
          items: {
            create: items.map((item: any) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              subtotal: item.quantity * item.unitPrice,
            })),
          },
        },
        include: { items: true },
      });

      return saleRecord;
    });

    res.status(201).json({
      message: "Transacción comercial procesada y auditada con éxito.",
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

export const getSales = async (req: Request, res: Response) => {
  try {
    const authUser = (req as any).user;

    // Filtro Multi-Sucursal: El empleado solo ve el historial de los locales donde trabaja
    const whereClause =
      authUser.role === "ADMIN" ? {} : { branchId: { in: authUser.branchIds } };

    const salesHistory = await prisma.sale.findMany({
      where: whereClause,
      include: {
        user: { select: { name: true, role: true } },
        items: { include: { product: { select: { name: true, sku: true } } } },
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

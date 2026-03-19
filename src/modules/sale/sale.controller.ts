import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// MOTOR TRANSACCIONAL DE VENTAS (POS)
// ============================================================================
export const createSale = async (req: Request, res: Response) => {
  try {
    const {
      branchId,
      userId,
      cashRegisterId,
      customerId,
      totalAmount,
      paymentMethod,
      status,
      items,
    } = req.body;

    if (!items || items.length === 0) {
      return res
        .status(400)
        .json({ error: "La venta debe contener al menos un producto." });
    }

    // Ejecutamos todo dentro de una transacción estricta (O todo o nada)
    const result = await prisma.$transaction(async (tx) => {
      // 1. Verificamos que la caja esté realmente abierta (Seguridad anti-fraude)
      const register = await tx.cashRegister.findUnique({
        where: { id: Number(cashRegisterId) },
      });
      if (!register || register.status !== "OPEN") {
        throw new Error(
          "La caja registradora está cerrada o no existe. Abra el turno primero.",
        );
      }

      // 2. Creamos la Cabecera de la Venta (El Ticket)
      const sale = await tx.sale.create({
        data: {
          totalAmount: Number(totalAmount),
          paymentMethod: paymentMethod,
          status: status, // "PAID" (Pagado) o "PENDING" (Fiado)
          balance: status === "PENDING" ? Number(totalAmount) : 0, // Si es fiado, todo va a saldo deudor
          branchId: Number(branchId),
          userId: Number(userId),
          cashRegisterId: Number(cashRegisterId),
          customerId: customerId ? Number(customerId) : null,
        },
      });

      // 3. Procesamos cada producto del carrito
      for (const item of items) {
        // A) Guardamos el renglón del ticket (Fijando el precio de venta en este exacto momento)
        await tx.saleItem.create({
          data: {
            saleId: sale.id,
            productId: Number(item.productId),
            quantity: Number(item.quantity),
            unitPrice: Number(item.unitPrice),
            subtotal: Number(item.subtotal),
          },
        });

        // B) Descontamos el stock físico de la sucursal actual
        const currentStock = await tx.stock.findUnique({
          where: {
            productId_branchId: {
              productId: Number(item.productId),
              branchId: Number(branchId),
            },
          },
        });

        const stockToDeduct = Number(item.quantity);
        const newQuantity = currentStock
          ? currentStock.quantity - stockToDeduct
          : -stockToDeduct;

        await tx.stock.upsert({
          where: {
            productId_branchId: {
              productId: Number(item.productId),
              branchId: Number(branchId),
            },
          },
          update: { quantity: newQuantity },
          create: {
            productId: Number(item.productId),
            branchId: Number(branchId),
            quantity: newQuantity,
            minStock: 5,
          },
        });

        // C) Dejamos registro en la Auditoría de Movimientos (Salida por Venta)
        await tx.movement.create({
          data: {
            type: "OUT",
            quantity: stockToDeduct,
            reason: `Venta #${sale.id}`,
            productId: Number(item.productId),
            branchId: Number(branchId),
            userId: Number(userId),
          },
        });
      }

      // 4. Si el cliente pagó (No es fiado), metemos la plata en la caja
      if (status === "PAID") {
        await tx.payment.create({
          data: {
            amount: Number(totalAmount),
            paymentMethod: paymentMethod,
            saleId: sale.id,
            userId: Number(userId),
            branchId: Number(branchId),
            cashRegisterId: Number(cashRegisterId),
          },
        });
      }

      return sale;
    });

    res.status(201).json({
      message:
        "Venta registrada, stock actualizado y dinero ingresado correctamente.",
      data: result,
    });
  } catch (error: unknown) {
    console.error("Error en motor de ventas:", error);
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Fallo crítico al procesar la transacción comercial.";
    res.status(400).json({ error: errorMsg });
  }
};

// ============================================================================
// HISTORIAL DE VENTAS: Listado para reportes y devoluciones
// ============================================================================
export const getSales = async (req: Request, res: Response) => {
  try {
    const { branchId } = req.query;

    const sales = await prisma.sale.findMany({
      where: branchId ? { branchId: Number(branchId) } : {},
      include: {
        customer: { select: { name: true, type: true } },
        user: { select: { name: true } },
        items: {
          include: { product: { select: { name: true, sku: true } } },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100, // Límite de seguridad para no saturar el panel
    });

    res.status(200).json({ data: sales });
  } catch (error: unknown) {
    res
      .status(500)
      .json({ error: "No se pudo recuperar el historial de ventas." });
  }
};

// ============================================================================
// DETALLE DE VENTA: Recuperar un ticket específico (Para reimpresión o consulta)
// ============================================================================
export const getSaleById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const sale = await prisma.sale.findUnique({
      where: { id: Number(id) },
      include: {
        customer: { select: { name: true, document: true, type: true } },
        user: { select: { name: true } },
        cashRegister: { select: { id: true } },
        items: {
          include: {
            product: { select: { name: true, sku: true, barcode: true } },
          },
        },
        payments: true,
      },
    });

    if (!sale) {
      return res.status(404).json({ error: "Ticket no encontrado." });
    }

    res.status(200).json({
      message: "Ticket recuperado exitosamente.",
      data: sale,
    });
  } catch (error: unknown) {
    console.error("Error al obtener detalle de venta:", error);
    res
      .status(500)
      .json({ error: "Fallo al recuperar los detalles del ticket comercial." });
  }
};

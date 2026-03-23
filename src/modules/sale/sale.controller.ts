import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// 1. MOTOR TRANSACCIONAL DE VENTAS Y CUENTAS CORRIENTES (ERP Level)
// ============================================================================
export const createSale = async (req: Request, res: Response) => {
  try {
    const {
      branchId,
      cashRegisterId,
      customerId,
      paymentMethod,
      totalAmount,
      items,
      pickedUpBy,
    } = req.body;

    const userId = (req as any).user.id;

    if (paymentMethod === "CREDIT_ACCOUNT") {
      if (!customerId)
        throw new Error(
          "Operación rechazada: Las ventas en Cuenta Corriente exigen un Cliente Titular registrado.",
        );
      if (!pickedUpBy || pickedUpBy.trim().length < 3)
        throw new Error(
          "Operación rechazada: Debe especificar el Nombre y DNI de la persona autorizada al retiro.",
        );
    }

    const result = await prisma.$transaction(async (tx) => {
      const activeRegister = await tx.cashRegister.findUnique({
        where: { id: Number(cashRegisterId) },
      });

      if (!activeRegister || activeRegister.status !== "OPEN") {
        throw new Error(
          "Operación bloqueada: No hay un turno de caja abierto para registrar esta operación.",
        );
      }

      const isCredit = paymentMethod === "CREDIT_ACCOUNT";
      const initialStatus = isCredit ? "PENDING" : "PAID";
      const initialBalance = isCredit ? Number(totalAmount) : 0;

      const newSale = await tx.sale.create({
        data: {
          totalAmount: Number(totalAmount),
          paymentMethod,
          status: initialStatus,
          balance: initialBalance,
          pickedUpBy: isCredit ? pickedUpBy : null,
          customerId: customerId ? Number(customerId) : null,
          branchId: Number(branchId),
          userId: Number(userId),
          cashRegisterId: Number(cashRegisterId),
        },
      });

      for (const item of items) {
        const currentStock = await tx.stock.findUnique({
          where: {
            productId_branchId: {
              productId: Number(item.productId),
              branchId: Number(branchId),
            },
          },
        });

        if (!currentStock || currentStock.quantity < Number(item.quantity)) {
          throw new Error(
            `Inconsistencia de Inventario: Stock insuficiente para el producto ID ${item.productId}.`,
          );
        }

        await tx.stock.update({
          where: { id: currentStock.id },
          data: { quantity: currentStock.quantity - Number(item.quantity) },
        });

        await tx.saleItem.create({
          data: {
            saleId: newSale.id,
            productId: Number(item.productId),
            quantity: Number(item.quantity),
            unitPrice: Number(item.unitPrice),
            subtotal: Number(item.quantity) * Number(item.unitPrice),
            unitCost: item.unitCost ? Number(item.unitCost) : 0,
          },
        });

        await tx.movement.create({
          data: {
            type: "OUT",
            quantity: Number(item.quantity),
            reason: `Venta #${newSale.id} ${isCredit ? "(Cuenta Corriente)" : ""}`,
            productId: Number(item.productId),
            branchId: Number(branchId),
            userId: Number(userId),
          },
        });
      }

      if (!isCredit && paymentMethod === "CASH") {
        await tx.payment.create({
          data: {
            amount: Number(totalAmount),
            paymentMethod: "CASH",
            saleId: newSale.id,
            userId: Number(userId),
            branchId: Number(branchId),
            cashRegisterId: Number(cashRegisterId),
          },
        });
      }

      return newSale;
    });

    res.status(201).json({
      message:
        paymentMethod === "CREDIT_ACCOUNT"
          ? "Venta a Crédito registrada."
          : "Venta procesada con éxito.",
      data: result,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Error crítico al procesar la venta.";
    res.status(400).json({ error: errorMsg });
  }
};

// ============================================================================
// 2. RADAR DE DEUDORES: Obtener todas las Cuentas Corrientes Pendientes
// ============================================================================
export const getPendingAccounts = async (req: Request, res: Response) => {
  try {
    const branchId = Number(req.params.branchId);

    const pendingSales = await prisma.sale.findMany({
      where: {
        branchId: branchId === 0 ? undefined : branchId,
        status: { in: ["PENDING", "PARTIAL"] },
      },
      include: {
        customer: { select: { id: true, name: true, type: true, phone: true } },
        user: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    res.status(200).json({ message: "Radar actualizado.", data: pendingSales });
  } catch (error: unknown) {
    res.status(500).json({ error: "Fallo al consultar el radar de deudores." });
  }
};

// ============================================================================
// 3. HISTORIAL GENERAL: Obtener listado de ventas (RESTAURADO)
// ============================================================================
export const getSales = async (req: Request, res: Response) => {
  try {
    // Tomamos las últimas 100 ventas para no saturar la red (paginación básica)
    const sales = await prisma.sale.findMany({
      take: 100,
      orderBy: { createdAt: "desc" },
      include: {
        customer: { select: { name: true, document: true } },
        user: { select: { name: true } }, // El empleado que hizo la venta
      },
    });

    res
      .status(200)
      .json({ message: "Historial de ventas recuperado.", data: sales });
  } catch (error: unknown) {
    res.status(500).json({ error: "Fallo al obtener el historial de ventas." });
  }
};

// ============================================================================
// 4. DETALLE DE TICKET: Recuperar venta para PDF o Consulta (RESTAURADO Y MEJORADO)
// ============================================================================
export const getSaleById = async (req: Request, res: Response) => {
  try {
    const saleId = Number(req.params.id);

    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        customer: true, // Datos del cliente
        user: { select: { name: true } }, // Cajero
        items: {
          include: {
            product: { select: { name: true, sku: true, brand: true } },
          },
        },
        payments: {
          // 🛡️ VITAL PARA FIADOS: Trae todos los pagos a cuenta que hizo
          orderBy: { createdAt: "desc" },
          include: { user: { select: { name: true } } },
        },
      },
    });

    if (!sale) throw new Error("Venta o Ticket no encontrado en el sistema.");

    res
      .status(200)
      .json({ message: "Detalle de ticket recuperado.", data: sale });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Error desconocido.";
    res.status(404).json({ error: errorMsg });
  }
};

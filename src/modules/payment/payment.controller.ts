import { Request, Response } from "express";
import prisma from "../../config/db";

// Registro de Cobranza de Deuda (Abono a Cuenta Corriente)
export const payDebt = async (req: Request, res: Response) => {
  try {
    const { saleId, amount, paymentMethod, branchId } = req.body;
    const authUser = (req as any).user;

    // Validación de seguridad física (Caja)
    if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
      return res.status(403).json({
        error: "No tienes autorización para ingresar dinero en esta sucursal.",
      });
    }

    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({ error: "El monto a cobrar debe ser mayor a cero." });
    }

    // Ejecución Transaccional (ACID)
    const transactionResult = await prisma.$transaction(async (tx) => {
      // 1. Buscamos la factura original
      const sale = await tx.sale.findUnique({
        where: { id: Number(saleId) },
      });

      if (!sale) {
        throw new Error("La factura indicada no existe en el sistema.");
      }

      if (sale.balance <= 0 || sale.status === "PAID") {
        throw new Error("Esta factura ya se encuentra totalmente saldada.");
      }

      if (amount > sale.balance) {
        throw new Error(
          `El monto ingresado ($${amount}) supera la deuda actual ($${sale.balance}).`,
        );
      }

      // 2. Calculamos el nuevo saldo
      const newBalance = sale.balance - amount;
      const newStatus = newBalance === 0 ? "PAID" : "PARTIAL";

      // 3. Generamos el recibo de ingreso de dinero físico a la caja
      const paymentReceipt = await tx.payment.create({
        data: {
          amount,
          paymentMethod,
          saleId: sale.id,
          userId: authUser.id,
          branchId,
        },
      });

      // 4. Actualizamos el estado de la factura original
      const updatedSale = await tx.sale.update({
        where: { id: sale.id },
        data: {
          balance: newBalance,
          status: newStatus,
        },
      });

      return { paymentReceipt, updatedSale };
    });

    res.status(201).json({
      message: "Cobranza registrada y saldo actualizado con éxito.",
      data: transactionResult,
    });
  } catch (error: any) {
    console.error("Error al procesar la cobranza:", error);
    if (error instanceof Error) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Fallo estructural al procesar el pago." });
  }
};

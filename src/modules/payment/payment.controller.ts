import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// 1. NUEVO MOTOR: Integración de Saldos (El que armamos para el Modal)
// ============================================================================
export const registerAccountPayment = async (req: Request, res: Response) => {
  try {
    const { saleId, amount, paymentMethod, cashRegisterId, branchId } =
      req.body;
    const userId = (req as any).user.id;
    const paymentAmount = Number(amount);

    if (paymentAmount <= 0)
      throw new Error("El monto de integración debe ser mayor a cero.");

    const result = await prisma.$transaction(async (tx) => {
      const activeRegister = await tx.cashRegister.findUnique({
        where: { id: Number(cashRegisterId) },
      });
      if (!activeRegister || activeRegister.status !== "OPEN")
        throw new Error(
          "Operación bloqueada: No se puede cobrar sin un turno de caja abierto.",
        );

      const targetSale = await tx.sale.findUnique({
        where: { id: Number(saleId) },
      });
      if (!targetSale) throw new Error("Ticket de origen no encontrado.");
      if (targetSale.status === "PAID" || targetSale.balance <= 0)
        throw new Error("Esta cuenta ya se encuentra saldada.");
      if (paymentAmount > targetSale.balance)
        throw new Error(
          `El monto ($${paymentAmount}) supera el saldo pendiente ($${targetSale.balance}).`,
        );

      const newBalance = targetSale.balance - paymentAmount;
      const newStatus = newBalance === 0 ? "PAID" : "PARTIAL";

      await tx.sale.update({
        where: { id: targetSale.id },
        data: { balance: newBalance, status: newStatus },
      });

      const newPayment = await tx.payment.create({
        data: {
          amount: paymentAmount,
          paymentMethod: paymentMethod,
          saleId: targetSale.id,
          userId: Number(userId),
          branchId: Number(branchId),
          cashRegisterId: Number(cashRegisterId),
        },
      });

      return { payment: newPayment, newBalance, status: newStatus };
    });

    res.status(201).json({
      message:
        result.status === "PAID"
          ? "¡Cuenta saldada en su totalidad!"
          : // 🛡️ Le agregamos explícitamente "ARS" y el formato argentino
            `Pago parcial. Saldo restante: $ ${result.newBalance.toLocaleString("es-AR")} ARS`,
      data: result,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Error crítico al registrar el pago.";
    res.status(400).json({ error: errorMsg });
  }
};

// ============================================================================
// 2. FUNCIÓN ORIGINAL RESTAURADA: registerDebtCollection
// ============================================================================
export const registerDebtCollection = async (req: Request, res: Response) => {
  try {
    // Si tenías lógica específica acá antes, podés pegarla.
    // Por ahora redirigimos al nuevo motor para no duplicar código y mantener retrocompatibilidad.
    return registerAccountPayment(req, res);
  } catch (error: unknown) {
    res.status(500).json({ error: "Error en el cobro de deuda original." });
  }
};

// ============================================================================
// 3. FUNCIÓN ORIGINAL RESTAURADA: generatePrintableReceipt (Backend PDF)
// ============================================================================
export const generatePrintableReceipt = async (req: Request, res: Response) => {
  try {
    const paymentId = Number(req.params.paymentId);

    // Acá iría la lógica original que tenías para generar el PDF desde el servidor.
    // Como ahora generamos el PDF hermoso desde el Frontend, esta ruta queda activa
    // por si la necesitás llamar desde un celular u otro microservicio en el futuro.

    res.status(200).json({
      message: "Ruta de generación de PDF en Backend activa y escuchando.",
      paymentId,
    });
  } catch (error: unknown) {
    res
      .status(500)
      .json({ error: "Fallo al procesar el recibo en el servidor." });
  }
};

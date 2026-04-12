import { Response } from "express";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";

class PaymentBranchAccessError extends Error {}

const allowedAccountPaymentMethods = new Set([
  "CASH",
  "DEBIT",
  "CREDIT",
  "TRANSFER",
  "MIXED",
]);

const parsePositiveInt = (value: unknown, fieldName: string) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} invalido.`);
  }

  return parsed;
};

const parsePositiveAmount = (value: unknown) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("El monto de integracion debe ser mayor a cero.");
  }

  return parsed;
};

const parseAccountPaymentMethod = (value: unknown) => {
  if (typeof value !== "string") {
    throw new Error("El medio de pago es obligatorio.");
  }

  const normalizedMethod = value.trim().toUpperCase();

  if (!allowedAccountPaymentMethods.has(normalizedMethod)) {
    throw new Error(
      "El medio de pago seleccionado no es valido para cobrar una cuenta corriente.",
    );
  }

  return normalizedMethod;
};

export const registerAccountPayment = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const { saleId, amount, paymentMethod, cashRegisterId } = req.body;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del cobrador.",
      });
    }

    const parsedSaleId = parsePositiveInt(saleId, "Ticket de origen");
    const parsedCashRegisterId = parsePositiveInt(
      cashRegisterId,
      "Turno de caja",
    );
    const paymentAmount = parsePositiveAmount(amount);
    const normalizedPaymentMethod = parseAccountPaymentMethod(paymentMethod);

    const result = await prisma.$transaction(async (tx) => {
      const activeRegister = await tx.cashRegister.findUnique({
        where: { id: parsedCashRegisterId },
      });

      if (!activeRegister || activeRegister.status !== "OPEN") {
        throw new Error(
          "Operacion bloqueada: No se puede cobrar sin un turno de caja abierto.",
        );
      }

      if (
        authUser.role !== "ADMIN" &&
        !authUser.branchIds.includes(activeRegister.branchId)
      ) {
        throw new PaymentBranchAccessError(
          "No tienes acceso a la sucursal de esta caja.",
        );
      }

      const targetSale = await tx.sale.findUnique({
        where: { id: parsedSaleId },
      });

      if (!targetSale) throw new Error("Ticket de origen no encontrado.");
      if (
        authUser.role !== "ADMIN" &&
        !authUser.branchIds.includes(targetSale.branchId)
      ) {
        throw new PaymentBranchAccessError(
          "No tienes acceso a la sucursal de esta cuenta.",
        );
      }
      if (targetSale.status === "PAID" || targetSale.balance <= 0) {
        throw new Error("Esta cuenta ya se encuentra saldada.");
      }
      if (targetSale.branchId !== activeRegister.branchId) {
        throw new Error(
          "La caja abierta no pertenece a la misma sucursal de la cuenta.",
        );
      }
      if (paymentAmount > targetSale.balance) {
        throw new Error(
          `El monto ($${paymentAmount}) supera el saldo pendiente ($${targetSale.balance}).`,
        );
      }

      const newBalance = targetSale.balance - paymentAmount;
      const newStatus = newBalance === 0 ? "PAID" : "PARTIAL";

      await tx.sale.update({
        where: { id: targetSale.id },
        data: { balance: newBalance, status: newStatus },
      });

      const newPayment = await tx.payment.create({
        data: {
          amount: paymentAmount,
          paymentMethod: normalizedPaymentMethod,
          saleId: targetSale.id,
          userId: authUser.id,
          branchId: targetSale.branchId,
          cashRegisterId: activeRegister.id,
        },
      });

      const receipt = await createInternalReceipt(tx, {
        receiptType: "PAYMENT",
        branchId: targetSale.branchId,
        cashRegisterId: activeRegister.id,
        saleId: targetSale.id,
        paymentId: newPayment.id,
        sourceId: newPayment.id,
        createdBy: authUser.id,
        payload: {
          paymentId: newPayment.id,
          saleId: targetSale.id,
          amount: paymentAmount,
          paymentMethod: normalizedPaymentMethod,
          previousBalance: targetSale.balance,
          newBalance,
          status: newStatus,
        },
      });

      return { payment: newPayment, receipt, newBalance, status: newStatus };
    });

    res.status(201).json({
      message:
        result.status === "PAID"
          ? "Cuenta saldada en su totalidad."
          : `Pago parcial. Saldo restante: $ ${result.newBalance.toLocaleString("es-AR")} ARS`,
      data: result,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Error critico al registrar el pago.";
    const statusCode = error instanceof PaymentBranchAccessError ? 403 : 400;

    res.status(statusCode).json({ error: errorMsg });
  }
};

export const registerDebtCollection = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    return await registerAccountPayment(req, res);
  } catch (error: unknown) {
    res.status(500).json({ error: "Error en el cobro de deuda original." });
  }
};

export const generatePrintableReceipt = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const paymentId = Number(req.params.paymentId);

    res.status(200).json({
      message: "Ruta de generacion de PDF en backend activa y escuchando.",
      paymentId,
    });
  } catch (error: unknown) {
    res
      .status(500)
      .json({ error: "Fallo al procesar el recibo en el servidor." });
  }
};

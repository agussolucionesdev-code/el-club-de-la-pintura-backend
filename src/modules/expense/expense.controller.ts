import { Prisma } from "@prisma/client";
import { Response } from "express";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";

const toJsonPayload = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const calculateAvailableCash = (shift: {
  initialBalance: number;
  payments: { amount: number; paymentMethod: string }[];
  expenses: { amount: number }[];
}) => {
  const totalCashPayments = shift.payments.reduce((acc, payment) => {
    return payment.paymentMethod.toUpperCase() === "CASH"
      ? acc + payment.amount
      : acc;
  }, 0);

  const totalExpenses = shift.expenses.reduce(
    (acc, expense) => acc + expense.amount,
    0,
  );

  return shift.initialBalance + totalCashPayments - totalExpenses;
};

export const getExpenses = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const expenses = await prisma.expense.findMany({
      where:
        authUser.role === "ADMIN"
          ? undefined
          : { branchId: { in: authUser.branchIds } },
      orderBy: { createdAt: "desc" },
      include: { user: { select: { name: true } } },
    });

    res
      .status(200)
      .json({ message: "Libro diario de egresos recuperado.", data: expenses });
  } catch (error) {
    res.status(500).json({ error: "Fallo al procesar el historial." });
  }
};

export const registerExpense = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { amount, reason, category, type, branchId, cashRegisterId } =
      req.body;
    const withdrawalAmount = Number(amount);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    if (!cashRegisterId) {
      return res.status(400).json({
        error: "Falta el identificador de la registradora.",
      });
    }

    if (
      authUser.role !== "ADMIN" &&
      !authUser.branchIds.includes(Number(branchId))
    ) {
      return res.status(403).json({ error: "No tienes acceso a esta sucursal." });
    }

    const transactionResult = await prisma.$transaction(async (tx) => {
      const activeShift = await tx.cashRegister.findUnique({
        where: { id: Number(cashRegisterId) },
        include: {
          expenses: true,
          payments: true,
        },
      });

      if (!activeShift || activeShift.status !== "OPEN") {
        throw new Error("Operacion denegada: La registradora no esta abierta.");
      }

      if (activeShift.branchId !== Number(branchId)) {
        throw new Error(
          "La caja abierta no pertenece a la sucursal seleccionada.",
        );
      }

      const availableCash = calculateAvailableCash(activeShift);

      if (withdrawalAmount > availableCash) {
        throw new Error(
          "No hay efectivo suficiente en la caja para registrar este egreso.",
        );
      }

      const newExpense = await tx.expense.create({
        data: {
          amount: withdrawalAmount,
          reason,
          category,
          type: type || "VARIABLE",
          branchId: activeShift.branchId,
          userId: authUser.id,
          cashRegisterId: activeShift.id,
        },
      });

      await tx.cashRegister.update({
        where: { id: activeShift.id },
        data: { expectedBalance: availableCash - withdrawalAmount },
      });

      const receipt = await createInternalReceipt(tx, {
        receiptType: "EXPENSE",
        branchId: activeShift.branchId,
        cashRegisterId: activeShift.id,
        sourceId: newExpense.id,
        createdBy: authUser.id,
        payload: {
          expenseId: newExpense.id,
          amount: withdrawalAmount,
          reason,
          category,
          type: type || "VARIABLE",
          previousExpectedBalance: availableCash,
          newExpectedBalance: availableCash - withdrawalAmount,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: activeShift.branchId,
          action: "expense.created",
          entityType: "Expense",
          entityId: String(newExpense.id),
          metadata: toJsonPayload({
            amount: withdrawalAmount,
            reason,
            category,
            type: type || "VARIABLE",
            cashRegisterId: activeShift.id,
            previousExpectedBalance: availableCash,
            newExpectedBalance: availableCash - withdrawalAmount,
            internalReceiptId: receipt.id,
            internalReceiptNumber: receipt.receiptNumber,
          }),
        },
      });

      return { expense: newExpense, receipt };
    });

    res.status(201).json({
      message: "Egreso registrado correctamente.",
      data: transactionResult.expense,
      receipt: transactionResult.receipt,
    });
  } catch (error) {
    if (error instanceof Error) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Fallo estructural al procesar." });
  }
};

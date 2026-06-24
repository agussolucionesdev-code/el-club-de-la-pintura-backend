/**
 * Expense Controller — operational expense (egreso de caja) management.
 *
 * Expenses are always linked to an OPEN cash register shift. Before recording
 * an expense, the controller validates that there is sufficient cash in the
 * drawer (initialBalance + cash payments - prior expenses ≥ new expense amount).
 * An internal receipt is created for each registered expense.
 *
 * Expense types: FIJO (fixed overhead), VARIABLE (ad-hoc operational).
 *
 * @module expense.controller
 */
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

/**
 * GET /expenses
 *
 * Returns expenses for the authenticated user's visible branches.
 * ADMIN sees all; non-ADMIN sees only their own branches.
 * Optional filter by cash register shift ID.
 *
 * @query cashRegisterId - Optional: filter by a specific shift.
 * @query branchId       - Optional: filter by branch.
 */
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
      include: {
        user: { select: { name: true } },
        supplier: { select: { id: true, companyName: true } },
      },
    });

    res
      .status(200)
      .json({ message: "Libro diario de egresos recuperado.", data: expenses });
  } catch (error) {
    res.status(500).json({ error: "Fallo al procesar el historial." });
  }
};

/**
 * POST /expenses
 *
 * Registers a new expense against the active cash register shift for a branch.
 * Validates that the drawer has sufficient cash before recording.
 * Creates an internal receipt for audit purposes.
 *
 * @body cashRegisterId - Active shift to charge the expense against.
 * @body branchId       - Branch where the expense occurs.
 * @body amount         - Expense amount in ARS (must be > 0 and ≤ available cash).
 * @body reason         - Description of the expense.
 * @body category       - Expense category (e.g., "ALQUILER", "LIMPIEZA").
 * @body type           - `"FIJO"` or `"VARIABLE"`.
 */
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
          // Voided expenses must NOT count against the drawer.
          expenses: { where: { voidedAt: null } },
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

/**
 * POST /expenses/:id/void
 *
 * Annuls an expense (soft-void with reason) preserving the audit trail. If the
 * originating shift is still OPEN, the cash is returned to the drawer. Voided
 * expenses are excluded from every cash/financial sum going forward.
 */
export const voidExpense = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const id = Number(req.params.id);
    const reason = String(req.body?.reason ?? "").trim();

    if (!authUser) {
      return res.status(401).json({ error: "No se pudo validar la identidad del usuario." });
    }
    if (reason.length < 3) {
      return res.status(400).json({ error: "Indicá el motivo de la anulación (mínimo 3 caracteres)." });
    }

    const result = await prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({
        where: { id },
        include: { cashRegister: { select: { id: true, status: true } } },
      });
      if (!expense) throw new Error("Egreso no encontrado.");
      if (expense.voidedAt) throw new Error("El egreso ya estaba anulado.");
      if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(expense.branchId)) {
        throw new Error("No tenés acceso a esta sucursal.");
      }

      const voided = await tx.expense.update({
        where: { id },
        data: { voidedAt: new Date(), voidReason: reason, voidedById: authUser.id },
      });

      // Refund the drawer only while the shift is still open.
      const shiftOpen = expense.cashRegister?.status === "OPEN";
      if (shiftOpen) {
        await tx.cashRegister.update({
          where: { id: expense.cashRegisterId },
          data: { expectedBalance: { increment: expense.amount } },
        });
      }

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: expense.branchId,
          action: "expense.voided",
          entityType: "Expense",
          entityId: String(id),
          metadata: toJsonPayload({
            reason,
            amount: expense.amount,
            category: expense.category,
            cashRegisterId: expense.cashRegisterId,
            cashRefunded: shiftOpen,
          }),
        },
      });

      return voided;
    });

    res.status(200).json({ message: "Egreso anulado correctamente.", data: result });
  } catch (error) {
    if (error instanceof Error) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: "Fallo al anular el egreso." });
  }
};

/**
 * PATCH /expenses/:id
 *
 * Edits the non-financial fields of an expense (reason, category, type,
 * supplier). The amount is intentionally immutable to keep cash reconciliation
 * intact — to correct an amount, void and re-register.
 */
export const updateExpense = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const id = Number(req.params.id);
    const { reason, category, type, supplierId } = req.body;

    if (!authUser) {
      return res.status(401).json({ error: "No se pudo validar la identidad del usuario." });
    }

    const expense = await prisma.expense.findUnique({ where: { id } });
    if (!expense) return res.status(404).json({ error: "Egreso no encontrado." });
    if (expense.voidedAt) return res.status(400).json({ error: "No se puede editar un egreso anulado." });
    if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(expense.branchId)) {
      return res.status(403).json({ error: "No tenés acceso a esta sucursal." });
    }

    const updated = await prisma.expense.update({
      where: { id },
      data: {
        ...(reason !== undefined && { reason: String(reason) }),
        ...(category !== undefined && { category: String(category) }),
        ...(type !== undefined && { type: String(type) }),
        ...(supplierId !== undefined && {
          supplierId: supplierId === null || supplierId === "" ? null : Number(supplierId),
        }),
      },
      include: { supplier: { select: { id: true, companyName: true } } },
    });

    await prisma.auditLog.create({
      data: {
        actorUserId: authUser.id,
        branchId: expense.branchId,
        action: "expense.updated",
        entityType: "Expense",
        entityId: String(id),
        metadata: toJsonPayload({ reason, category, type, supplierId }),
      },
    });

    res.status(200).json({ message: "Egreso actualizado.", data: updated });
  } catch (error) {
    if (error instanceof Error) return res.status(400).json({ error: error.message });
    res.status(500).json({ error: "Fallo al actualizar el egreso." });
  }
};

import { Prisma } from "@prisma/client";
import { Response } from "express";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";

interface CashRegisterShift {
  initialBalance: number;
  payments: { amount: number; paymentMethod: string }[];
  expenses: { amount: number }[];
}

interface CashDenominationBreakdown {
  denomination: number;
  quantity: number;
  subtotal: number;
}

interface CashRegisterSyncSafety {
  localPendingOperations: number;
  localFailedOperations: number;
  serverPendingSyncOperations: number;
  serverRejectedSyncOperations: number;
}

const normalizePaymentMethod = (paymentMethod: string) =>
  paymentMethod.trim().toUpperCase() || "UNKNOWN";

const roundMoney = (value: number) => Math.round(value * 100) / 100;

const toJsonPayload = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const normalizeDenominationBreakdown = (
  value: unknown,
): CashDenominationBreakdown[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }

      const typedItem = item as Record<string, unknown>;
      const denomination = Number(typedItem.denomination);
      const quantity = Number(typedItem.quantity);

      if (
        !Number.isFinite(denomination) ||
        denomination <= 0 ||
        !Number.isInteger(quantity) ||
        quantity < 0
      ) {
        return null;
      }

      return {
        denomination: roundMoney(denomination),
        quantity,
        subtotal: roundMoney(denomination * quantity),
      };
    })
    .filter((item): item is CashDenominationBreakdown => Boolean(item))
    .filter((item) => item.quantity > 0)
    .sort((a, b) => b.denomination - a.denomination);
};

const buildCashRegisterSummary = (shift: CashRegisterShift) => {
  const paymentsByMethod = shift.payments.reduce<Record<string, number>>(
    (acc, payment) => {
      const method = normalizePaymentMethod(payment.paymentMethod);
      acc[method] = roundMoney((acc[method] || 0) + payment.amount);
      return acc;
    },
    {},
  );

  const totalCashPayments = shift.payments.reduce((acc, payment) => {
    return normalizePaymentMethod(payment.paymentMethod) === "CASH"
      ? acc + payment.amount
      : acc;
  }, 0);

  const totalPayments = shift.payments.reduce(
    (acc, payment) => acc + payment.amount,
    0,
  );
  const totalExpenses = shift.expenses.reduce(
    (acc, expense) => acc + expense.amount,
    0,
  );
  const expectedBalance =
    shift.initialBalance + totalCashPayments - totalExpenses;

  return {
    initialBalance: roundMoney(shift.initialBalance),
    paymentsByMethod,
    totalPayments: roundMoney(totalPayments),
    totalCashPayments: roundMoney(totalCashPayments),
    totalNonCashPayments: roundMoney(totalPayments - totalCashPayments),
    totalExpenses: roundMoney(totalExpenses),
    netCashMovement: roundMoney(totalCashPayments - totalExpenses),
    expectedBalance: roundMoney(expectedBalance),
    paymentsCount: shift.payments.length,
    expensesCount: shift.expenses.length,
  };
};

const buildCashRegisterSyncSafety = async (
  branchId: number,
  localPendingOperations = 0,
  localFailedOperations = 0,
): Promise<CashRegisterSyncSafety> => {
  const [serverPendingSyncOperations, serverRejectedSyncOperations] =
    await Promise.all([
      prisma.syncOperation.count({
        where: {
          branchId,
          status: { in: ["PENDING", "PROCESSING"] },
        },
      }),
      prisma.syncOperation.count({
        where: { branchId, status: "REJECTED" },
      }),
    ]);

  return {
    localPendingOperations: Math.max(0, Number(localPendingOperations) || 0),
    localFailedOperations: Math.max(0, Number(localFailedOperations) || 0),
    serverPendingSyncOperations,
    serverRejectedSyncOperations,
  };
};

const hasBlockingSyncRisk = (syncSafety: CashRegisterSyncSafety) =>
  syncSafety.localPendingOperations > 0 ||
  syncSafety.localFailedOperations > 0 ||
  syncSafety.serverPendingSyncOperations > 0 ||
  syncSafety.serverRejectedSyncOperations > 0;

export const getActiveShift = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.params.branchId);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del operador.",
      });
    }

    if (!Number.isInteger(branchId) || branchId <= 0) {
      return res.status(400).json({
        error: "La sucursal indicada no es valida.",
      });
    }

    if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
      return res.status(403).json({
        error: "No tienes acceso a la caja de la sucursal indicada.",
      });
    }

    const activeShift = await prisma.cashRegister.findFirst({
      where: {
        branchId,
        status: "OPEN",
      },
      include: {
        user: { select: { id: true, name: true } },
        expenses: true,
        payments: true,
      },
    });

    if (!activeShift) {
      return res.status(200).json({
        message: "No hay turnos abiertos.",
        data: null,
      });
    }

    const cashSummary = buildCashRegisterSummary(activeShift);
    const syncSafety = await buildCashRegisterSyncSafety(branchId);

    res.status(200).json({
      message: "Turno activo recuperado.",
      data: {
        ...activeShift,
        currentExpectedBalance: cashSummary.expectedBalance,
        cashSummary,
        syncSafety: {
          ...syncSafety,
          canClose: !hasBlockingSyncRisk(syncSafety),
        },
      },
    });
  } catch (error: unknown) {
    console.error("Error al obtener estado de caja:", error);
    res
      .status(500)
      .json({ error: "Fallo de conexion al consultar el cajon de dinero." });
  }
};

export const openShift = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { initialBalance, branchId } = req.body;
    const parsedBranchId = Number(branchId);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del operador.",
      });
    }

    if (!Number.isInteger(parsedBranchId) || parsedBranchId <= 0) {
      return res.status(400).json({
        error: "La sucursal indicada no es valida.",
      });
    }

    if (
      authUser.role !== "ADMIN" &&
      !authUser.branchIds.includes(parsedBranchId)
    ) {
      return res.status(403).json({
        error: "No tienes acceso a la sucursal indicada.",
      });
    }

    const existingOpen = await prisma.cashRegister.findFirst({
      where: { branchId: parsedBranchId, status: "OPEN" },
    });

    if (existingOpen) {
      return res.status(400).json({
        error:
          "Atencion: Ya existe un turno abierto en esta sucursal. Debe cerrarlo antes de iniciar uno nuevo.",
      });
    }

    const newShift = await prisma.cashRegister.create({
      data: {
        initialBalance: Number(initialBalance),
        userId: authUser.id,
        branchId: parsedBranchId,
        status: "OPEN",
      },
    });

    res.status(201).json({
      message:
        "Caja abierta exitosamente. Que sea una excelente jornada de ventas.",
      data: newShift,
    });
  } catch (error: unknown) {
    console.error("Error critico al abrir caja:", error);
    res.status(500).json({
      error:
        "Fallo de integridad: Verifique que el usuario y la sucursal existan en la base de datos.",
    });
  }
};

export const closeShift = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { id } = req.params;
    const {
      actualBalance,
      observations,
      localPendingOperations = 0,
      localFailedOperations = 0,
      denominationBreakdown,
    } = req.body;
    const cashDenominationBreakdown =
      normalizeDenominationBreakdown(denominationBreakdown);
    const denominationTotal = roundMoney(
      cashDenominationBreakdown.reduce((acc, item) => acc + item.subtotal, 0),
    );
    const hasExplicitActualBalance =
      actualBalance !== undefined && actualBalance !== null && actualBalance !== "";
    const countedBalance = hasExplicitActualBalance
      ? Number(actualBalance)
      : cashDenominationBreakdown.length > 0
        ? denominationTotal
        : Number.NaN;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del operador.",
      });
    }

    if (!Number.isFinite(countedBalance) || countedBalance < 0) {
      return res.status(400).json({
        error: "El dinero fisico contado debe ser un monto valido y no negativo.",
      });
    }

    if (
      cashDenominationBreakdown.length > 0 &&
      Math.abs(roundMoney(countedBalance - denominationTotal)) > 0.01
    ) {
      return res.status(400).json({
        error:
          "El total declarado no coincide con el conteo por denominaciones.",
      });
    }

    const shift = await prisma.cashRegister.findUnique({
      where: { id: Number(id) },
      include: {
        payments: true,
        expenses: true,
      },
    });

    if (!shift || shift.status === "CLOSED") {
      return res.status(400).json({
        error: "El turno indicado no existe o ya fue cerrado previamente.",
      });
    }

    if (
      authUser.role !== "ADMIN" &&
      !authUser.branchIds.includes(shift.branchId)
    ) {
      return res.status(403).json({
        error: "No tienes acceso a la sucursal donde se abrio esta caja.",
      });
    }

    const cashSummary = buildCashRegisterSummary(shift);
    const expectedBalance = cashSummary.expectedBalance;
    const discrepancy = roundMoney(countedBalance - expectedBalance);
    const syncSafety = await buildCashRegisterSyncSafety(
      shift.branchId,
      localPendingOperations,
      localFailedOperations,
    );

    if (hasBlockingSyncRisk(syncSafety)) {
      return res.status(409).json({
        error:
          "No se puede cerrar la caja con operaciones offline pendientes o conflictos de sincronizacion sin resolver. Sincronice, resuelva los conflictos y vuelva a intentar.",
        data: {
          cashRegisterId: shift.id,
          branchId: shift.branchId,
          expectedBalance,
          actualBalance: countedBalance,
          discrepancy,
          ...syncSafety,
        },
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const closedShift = await tx.cashRegister.update({
        where: { id: Number(id) },
        data: {
          status: "CLOSED",
          closingTime: new Date(),
          expectedBalance,
          actualBalance: countedBalance,
          discrepancy,
          observations: observations || null,
        },
      });

      const receipt = await createInternalReceipt(tx, {
        receiptType: "CASH_CLOSE",
        branchId: shift.branchId,
        cashRegisterId: shift.id,
        sourceId: shift.id,
        createdBy: authUser.id,
        payload: {
          cashRegisterId: shift.id,
          openedAt: shift.openingTime,
          closedAt: closedShift.closingTime,
          initialBalance: shift.initialBalance,
          expectedBalance,
          actualBalance: countedBalance,
          discrepancy,
          observations: observations || null,
          totalCashPayments: cashSummary.totalCashPayments,
          totalNonCashPayments: cashSummary.totalNonCashPayments,
          totalPayments: cashSummary.totalPayments,
          totalExpenses: cashSummary.totalExpenses,
          netCashMovement: cashSummary.netCashMovement,
          paymentsCount: cashSummary.paymentsCount,
          expensesCount: cashSummary.expensesCount,
          paymentsByMethod: cashSummary.paymentsByMethod,
          ...syncSafety,
          denominationBreakdown: cashDenominationBreakdown,
          denominationTotal,
          countedByDenominations: cashDenominationBreakdown.length > 0,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: shift.branchId,
          action: "cash_register.closed",
          entityType: "CashRegister",
          entityId: String(shift.id),
          metadata: toJsonPayload({
            expectedBalance,
            actualBalance: countedBalance,
            discrepancy,
            totalCashPayments: cashSummary.totalCashPayments,
            totalExpenses: cashSummary.totalExpenses,
            ...syncSafety,
            denominationTotal,
            countedByDenominations: cashDenominationBreakdown.length > 0,
            internalReceiptId: receipt.id,
            internalReceiptNumber: receipt.receiptNumber,
          }),
        },
      });

      return { closedShift, receipt };
    });

    res.status(200).json({
      message: "El turno ha sido cerrado y arqueado correctamente.",
      data: {
        ...result.closedShift,
        cashSummary: {
          ...cashSummary,
          actualBalance: countedBalance,
          discrepancy,
          ...syncSafety,
          denominationBreakdown: cashDenominationBreakdown,
          denominationTotal,
          countedByDenominations: cashDenominationBreakdown.length > 0,
        },
      },
      receipt: result.receipt,
    });
  } catch (error: unknown) {
    console.error("Error al cerrar caja:", error);
    res.status(500).json({
      error: "Fallo critico al intentar realizar el cierre contable.",
    });
  }
};

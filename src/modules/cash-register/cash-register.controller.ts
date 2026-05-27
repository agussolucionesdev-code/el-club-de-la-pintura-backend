/**
 * Cash Register Controller — shift management (apertura/cierre de caja) and reporting.
 *
 * Business rules enforced here:
 * - Only one OPEN shift is allowed per branch at a time.
 * - Closing a shift is blocked while there are pending or failed offline sync operations
 *   (checked both locally via the request body and on the server via `syncOperation` table).
 * - The Corte Z PDF date is built using `localDayRange` to prevent the UTC-midnight
 *   off-by-one bug in the UTC-3 timezone (Argentina).
 *
 * @module cash-register.controller
 */
import { Prisma } from "@prisma/client";
import { logger } from '../../config/logger';
import { Response } from "express";
import PDFDocument from "pdfkit";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";
import { localDayRange } from "../../utils/date.utils";

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

/**
 * GET /cash-registers/:branchId/active
 *
 * Returns the currently open shift for the given branch, including a live
 * cash summary (expected balance, payments by method, expenses) and the sync
 * safety report (pending/rejected operations that would block closing).
 * Returns `data: null` with 200 if no shift is open.
 *
 * Access: ADMIN (any branch), ENCARGADO/EMPLOYEE (own branches only).
 */
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
    logger.error("Error al obtener estado de caja:", error);
    res
      .status(500)
      .json({ error: "Fallo de conexion al consultar el cajon de dinero." });
  }
};

/**
 * POST /cash-registers/open
 *
 * Opens a new cash-register shift for the given branch with an initial balance
 * (the cash physically in the drawer at the start of the shift).
 * Returns 409 if a shift is already open for that branch.
 *
 * @body branchId       - Target branch ID.
 * @body initialBalance - Opening cash amount in the drawer (ARS).
 */
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
    logger.error("Error critico al abrir caja:", error);
    res.status(500).json({
      error:
        "Fallo de integridad: Verifique que el usuario y la sucursal existan en la base de datos.",
    });
  }
};

/**
 * PATCH /cash-registers/:id/close
 *
 * Closes the shift identified by `:id`. Validates that there are no pending
 * or failed offline sync operations before allowing the close (prevents
 * accidental closing with unsynced data). Saves the denomination breakdown,
 * discrepancy (counted vs. expected), and optional observations.
 * Also creates an internal receipt for audit purposes.
 *
 * @param id - Cash register shift ID.
 * @body actualBalance          - Cash physically counted in the drawer (ARS).
 * @body observations           - Optional text note for the shift.
 * @body denominationBreakdown  - Array of `{ denomination, quantity }` entries.
 * @body localPendingOperations - Count reported by the client device.
 * @body localFailedOperations  - Count reported by the client device.
 */
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
    logger.error("Error al cerrar caja:", error);
    res.status(500).json({
      error: "Fallo critico al intentar realizar el cierre contable.",
    });
  }
};

/**
 * GET /cash-registers/:branchId/history
 *
 * Returns a paginated list of CLOSED shifts for the given branch.
 * Pass `branchId=0` to retrieve history across all branches (ADMIN gets all;
 * non-ADMIN gets only their own branches).
 *
 * @param branchId - Branch ID, or 0 for cross-branch history.
 * @query page  - Page number (default: 1).
 * @query limit - Page size, max 50 (default: 20).
 */
export const getShiftHistory = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.params.branchId);
    const page = Math.max(1, Number(req.query.page ?? 1));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));
    const skip = (page - 1) * limit;

    if (!authUser) {
      return res.status(401).json({ error: "No autorizado." });
    }

    const where =
      branchId === 0
        ? authUser.role === "ADMIN"
          ? { status: "CLOSED" as const }
          : { branchId: { in: authUser.branchIds }, status: "CLOSED" as const }
        : { branchId, status: "CLOSED" as const };

    const [shifts, total] = await Promise.all([
      prisma.cashRegister.findMany({
        where,
        orderBy: { closingTime: "desc" },
        skip,
        take: limit,
        include: {
          user: { select: { name: true } },
          branch: { select: { name: true } },
          _count: { select: { sales: true, expenses: true } },
        },
      }),
      prisma.cashRegister.count({ where }),
    ]);

    res.status(200).json({
      message: "Historial de turnos recuperado.",
      data: shifts,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (error: unknown) {
    logger.error("Error al obtener historial de caja:", error);
    res.status(500).json({ error: "No se pudo obtener el historial de caja." });
  }
};

/**
 * GET /cash-registers/corte-z/pdf
 *
 * Streams a PDF "Corte Z" (daily closing report) for the requested branch and
 * date. The report includes: sales totals by payment method, expenses, expected
 * cash balance, and discrepancy from the last closed shift.
 *
 * **Date caveat**: the `date` query param must be a `YYYY-MM-DD` local-time
 * string. Internally, `localDayRange()` converts it to UTC boundaries so the
 * query captures all sales within the Argentine calendar day, not UTC day.
 *
 * @query branchId - Target branch ID (required for non-ADMIN users).
 * @query date     - Target date `YYYY-MM-DD` in local time (defaults to today).
 */
export const generateCorteZPdf = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autorizado." });

    const branchId = Number(req.query.branchId ?? 0);
    const dateStr = req.query.date as string | undefined;

    // Date range for the requested day (defaults to today)
    // IMPORTANT: use localDayRange to avoid the UTC off-by-one bug with YYYY-MM-DD strings
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const { from, to } = localDayRange(dateStr ?? todayStr);
    const targetDate = from; // PDF label anchor — already midnight local time

    const branchFilter =
      branchId > 0
        ? { branchId }
        : authUser.role === "ADMIN"
          ? {}
          : { branchId: { in: authUser.branchIds } };

    const [sales, expenses, branch] = await Promise.all([
      prisma.sale.findMany({
        where: { ...branchFilter, createdAt: { gte: from, lte: to }, status: { in: ["PAID", "PARTIAL"] } },
        include: { payments: true },
      }),
      prisma.expense.findMany({
        where: { ...branchFilter, createdAt: { gte: from, lte: to } },
      }),
      branchId > 0
        ? prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } })
        : Promise.resolve(null),
    ]);

    // Aggregate totals by payment method
    const paymentsByMethod: Record<string, number> = {};
    let totalSales = 0;
    for (const sale of sales) {
      totalSales += Number(sale.totalAmount);
      for (const p of sale.payments) {
        paymentsByMethod[p.paymentMethod] =
          (paymentsByMethod[p.paymentMethod] ?? 0) + Number(p.amount);
      }
      if (sale.payments.length === 0) {
        paymentsByMethod[sale.paymentMethod] =
          (paymentsByMethod[sale.paymentMethod] ?? 0) + Number(sale.totalAmount);
      }
    }
    const totalExpenses = expenses.reduce((s, e) => s + Number(e.amount), 0);
    const totalCash = paymentsByMethod["CASH"] ?? 0;
    const netCash = totalCash - totalExpenses;

    const METHOD_LABELS: Record<string, string> = {
      CASH: "Efectivo",
      DEBIT: "Débito",
      CREDIT: "Crédito",
      TRANSFER: "Transferencia",
      CREDIT_ACCOUNT: "Cuenta corriente",
      MIXED: "Mixto",
    };

    const fmt = (n: number) =>
      n.toLocaleString("es-AR", { style: "currency", currency: "ARS" });

    const now = new Date();
    const dateLabel = targetDate.toLocaleDateString("es-AR", {
      weekday: "long",
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
    const branchLabel = branch?.name ?? "Todas las sucursales";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename=CorteZ_${targetDate.toISOString().slice(0, 10)}.pdf`,
    );

    const doc = new PDFDocument({ size: [226.77, 620], margin: 18 });
    doc.pipe(res);

    doc.fontSize(13).font("Helvetica-Bold").text("El Club de la Pintura", { align: "center" });
    doc.moveDown(0.2);
    doc.fontSize(9).font("Helvetica").text("CORTE Z — Cierre de Jornada", { align: "center" });
    doc.fontSize(8).text(branchLabel, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(8).text(`Fecha: ${dateLabel}`);
    doc.text(`Generado: ${now.toLocaleString("es-AR")}`);
    doc.moveDown(0.5);
    doc.moveTo(18, doc.y).lineTo(208.77, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font("Helvetica-Bold").fontSize(8).text("VENTAS DEL DÍA");
    doc.font("Helvetica").fontSize(8);
    for (const [method, amount] of Object.entries(paymentsByMethod)) {
      doc.text(`  ${METHOD_LABELS[method] ?? method}: ${fmt(amount)}`);
    }
    doc.font("Helvetica-Bold").text(`  TOTAL COBRADO: ${fmt(totalSales)}`);
    doc.moveDown(0.5);

    doc.moveTo(18, doc.y).lineTo(208.77, doc.y).stroke();
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(8).text("GASTOS DEL DÍA");
    doc.font("Helvetica").fontSize(8);
    for (const expense of expenses) {
      doc.text(`  ${expense.reason}: ${fmt(Number(expense.amount))}`);
    }
    doc.font("Helvetica-Bold").text(`  TOTAL GASTOS: ${fmt(totalExpenses)}`);
    doc.moveDown(0.5);

    doc.moveTo(18, doc.y).lineTo(208.77, doc.y).stroke();
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(9).text(`NETO EN EFECTIVO: ${fmt(netCash)}`, { align: "center" });
    doc.font("Helvetica").fontSize(8).text(`Ventas: ${sales.length}  |  Gastos: ${expenses.length}`, { align: "center" });
    doc.moveDown(0.5);
    doc.moveTo(18, doc.y).lineTo(208.77, doc.y).stroke();
    doc.moveDown(0.3);
    doc.fontSize(7).text("El Club de la Pintura — Sistema ERP/POS", { align: "center" });
    doc.text("Documento de uso interno", { align: "center" });

    doc.end();
  } catch (error: unknown) {
    logger.error("Error generating Corte Z PDF:", error);
    res.status(500).json({ error: "No se pudo generar el Corte Z." });
  }
};

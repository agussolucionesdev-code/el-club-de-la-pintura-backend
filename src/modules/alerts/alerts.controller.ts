/**
 * Alerts Controller — one consolidated status read for the sidebar.
 *
 * Every nav badge in the app resolves from this single endpoint. It exists so
 * the frontend polls once instead of once per badge: each indicator used to
 * carry its own poll, which multiplied requests against the backend for data
 * that is always read together.
 *
 * Each block is role-gated server-side rather than merely hidden in the UI, so
 * an EMPLOYEE never receives payroll or credit figures they cannot open.
 *
 * @module alerts.controller
 */
import { Response } from "express";
import { logger } from "../../config/logger";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

type AuthUser = { id: number; role: string; branchIds: number[] };

/**
 * Resolves the branch filter for a request. `branchId = 0` is the consolidated
 * view: ADMIN sees every branch, anyone else is narrowed to their own.
 */
const resolveBranchWhere = (branchId: number, authUser: AuthUser) => {
  if (!Number.isInteger(branchId) || branchId < 0) {
    throw new Error("Sucursal inválida.");
  }

  if (branchId === 0) {
    return authUser.role === "ADMIN" ? undefined : { in: authUser.branchIds };
  }

  if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
    throw new Error("No tienes acceso a la sucursal indicada.");
  }

  return branchId;
};

export interface AlertsSummary {
  cash: { open: boolean | null; shiftId: number | null };
  stock: { critical: number; warning: number; total: number } | null;
  accounts: { overLimit: number; withDebt: number; totalDebt: number } | null;
  payroll: { pending: number } | null;
}

/**
 * GET /alerts/summary
 *
 * Returns every sidebar indicator in one payload. Blocks the caller's role
 * cannot act on come back as `null` rather than zeroed, so the UI can tell
 * "nothing to report" apart from "not your business".
 *
 * @query branchId - Branch filter (0 = consolidated; ADMIN only across all).
 */
export const getAlertsSummary = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autorizado." });

    const branchId = Number(req.query.branchId ?? 0);
    const branchWhere = resolveBranchWhere(branchId, authUser);
    const canSeeOps = authUser.role === "ADMIN" || authUser.role === "ENCARGADO";
    const isAdmin = authUser.role === "ADMIN";

    // ── Caja: is there an open shift in this branch? ──────────────────────
    // Only meaningful for a concrete branch: the consolidated view spans
    // several shifts at once, so it reports nothing rather than something
    // misleading.
    const cashShift =
      branchId > 0
        ? await prisma.cashRegister.findFirst({
            where: { branchId, status: "OPEN" },
            select: { id: true },
          })
        : null;

    const summary: AlertsSummary = {
      cash: {
        open: branchId > 0 ? cashShift !== null : null,
        shiftId: cashShift?.id ?? null,
      },
      stock: null,
      accounts: null,
      payroll: null,
    };

    // ── Stock: below-threshold counts ────────────────────────────────────
    if (canSeeOps) {
      const stocks = await prisma.stock.findMany({
        where: {
          ...(branchWhere === undefined ? {} : { branchId: branchWhere }),
          product: { isActive: true },
        },
        select: { quantity: true, minStock: true, criticalStock: true },
      });
      // Filtered here because Prisma cannot compare two columns in `where`.
      const atAlert = stocks.filter((s) => s.quantity <= s.minStock);
      const critical = atAlert.filter((s) => s.quantity <= s.criticalStock).length;
      summary.stock = {
        critical,
        warning: atAlert.length - critical,
        total: atAlert.length,
      };
    }

    // ── Cuentas corrientes: open debt and customers past their limit ──────
    if (canSeeOps) {
      const debtors = await prisma.customer.findMany({
        where: { isActive: true, sales: { some: { status: { in: ["PENDING", "PARTIAL"] } } } },
        select: {
          creditLimit: true,
          sales: {
            where: { status: { in: ["PENDING", "PARTIAL"] } },
            select: { balance: true },
          },
        },
      });

      let overLimit = 0;
      let withDebt = 0;
      let totalDebt = 0;

      for (const c of debtors) {
        const debt = c.sales.reduce((sum, s) => sum + Number(s.balance), 0);
        if (debt <= 0) continue;
        withDebt += 1;
        totalDebt += debt;
        // creditLimit 0 means "no limit set", so it can never be exceeded.
        if (c.creditLimit > 0 && debt > c.creditLimit) overLimit += 1;
      }

      summary.accounts = { overLimit, withDebt, totalDebt };
    }

    // ── Liquidaciones pendientes de pago ─────────────────────────────────
    if (isAdmin) {
      const pending = await prisma.payrollRecord.count({
        where: { status: "PENDING" },
      });
      summary.payroll = { pending };
    }

    res.status(200).json(summary);
  } catch (error: unknown) {
    logger.error("Error al obtener el resumen de alertas:", error);
    res.status(500).json({ error: "No se pudo obtener el resumen de alertas." });
  }
};

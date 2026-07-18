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
import { readSettings } from "../settings/settings.controller";

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

    // What the owner chose to be told about. A silenced alert is not queried
    // at all, so turning one off also saves the work of computing it.
    const settings = await readSettings();

    // ── Caja: is there an open shift in this branch? ──────────────────────
    // Only meaningful for a concrete branch: the consolidated view spans
    // several shifts at once, so it reports nothing rather than something
    // misleading.
    const cashShift =
      settings.alertCashEnabled && branchId > 0
        ? await prisma.cashRegister.findFirst({
            where: { branchId, status: "OPEN" },
            select: { id: true },
          })
        : null;

    const summary: AlertsSummary = {
      cash: {
        open: settings.alertCashEnabled && branchId > 0 ? cashShift !== null : null,
        shiftId: cashShift?.id ?? null,
      },
      stock: null,
      accounts: null,
      payroll: null,
    };

    // ── Stock: below-threshold counts ────────────────────────────────────
    if (canSeeOps && settings.alertStockEnabled) {
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
      // Below the owner's floor there is nothing worth badging the menu for.
      summary.stock =
        atAlert.length >= settings.alertStockMinCount
          ? { critical, warning: atAlert.length - critical, total: atAlert.length }
          : { critical: 0, warning: 0, total: 0 };
    }

    // ── Cuentas corrientes: open debt and customers past their limit ──────
    if (canSeeOps && settings.alertAccountsEnabled) {
      const OPEN = { in: ["PENDING", "PARTIAL"] };

      // Debt belongs to the branch that made the sale. This filter was missing,
      // so every branch reported the same figure — Temperley's three debtors
      // showed up in Lomas de Zamora too, which made the badge worthless.
      const saleInBranch = {
        status: OPEN,
        ...(branchWhere === undefined ? {} : { branchId: branchWhere }),
      };

      const debtors = await prisma.customer.findMany({
        // Only customers who owe something *here*.
        where: { isActive: true, sales: { some: saleInBranch } },
        select: {
          creditLimit: true,
          // Every open sale of theirs, branch included: the money owed here is
          // one question, whether they blew their credit limit is another.
          sales: { where: { status: OPEN }, select: { balance: true, branchId: true } },
        },
      });

      /** Does this sale count towards the branch currently on screen? */
      const inScope = (saleBranchId: number) => {
        if (branchWhere === undefined) return true; // consolidated (ADMIN)
        if (typeof branchWhere === "number") return saleBranchId === branchWhere;
        return branchWhere.in.includes(saleBranchId); // consolidated, own branches
      };

      let overLimit = 0;
      let withDebt = 0;
      let totalDebt = 0;

      for (const c of debtors) {
        let branchDebt = 0;
        let customerDebt = 0;
        for (const s of c.sales) {
          const amount = Number(s.balance);
          customerDebt += amount;
          if (inScope(s.branchId)) branchDebt += amount;
        }

        if (branchDebt <= 0) continue; // owes nothing here — not this branch's alert
        withDebt += 1;
        totalDebt += branchDebt;

        // The credit limit is the customer's, not the branch's: they are over it
        // based on everything they owe. Reported here only because they also owe
        // money at this branch, so the number always matches what you can act on.
        // creditLimit 0 means "no limit set", so it can never be exceeded.
        if (c.creditLimit > 0 && customerDebt > c.creditLimit) overLimit += 1;
      }

      // Small debt is normal in a paint shop; the owner sets what counts as
      // worth a badge. Customers over their credit limit always report — that
      // is the money-losing case, not a matter of volume.
      summary.accounts =
        totalDebt >= settings.alertAccountsMinDebt || overLimit > 0
          ? { overLimit, withDebt, totalDebt }
          : { overLimit: 0, withDebt: 0, totalDebt };
    }

    // ── Liquidaciones pendientes de pago ─────────────────────────────────
    if (isAdmin && settings.alertPayrollEnabled) {
      // Same bug as accounts had: staff belong to a branch, so unpaid wages
      // are counted where the employee works instead of company-wide.
      const pending = await prisma.payrollRecord.count({
        where: {
          status: "PENDING",
          ...(branchWhere === undefined ? {} : { employee: { branchId: branchWhere } }),
        },
      });
      summary.payroll = { pending };
    }

    res.status(200).json(summary);
  } catch (error: unknown) {
    logger.error("Error al obtener el resumen de alertas:", error);
    res.status(500).json({ error: "No se pudo obtener el resumen de alertas." });
  }
};

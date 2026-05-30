/**
 * Dashboard Controller — business intelligence and reporting endpoints.
 *
 * All endpoints require a valid JWT (handled by the auth middleware).
 * ADMIN users can query the consolidated view (`branchId=0`); ENCARGADO and
 * EMPLOYEE are restricted to their own branches.
 *
 * Date filtering: `from` / `to` query params accept `YYYY-MM-DD` strings which
 * are parsed as **local time** (Argentina, UTC-3) via `parseLocalDate` to avoid
 * the UTC-midnight off-by-one bug.
 *
 * Query safety: every `findMany` call has a `take` cap to prevent OOM crashes
 * on large production datasets.
 *
 * @module dashboard.controller
 */
import { Request, Response } from "express";
import { logger } from '../../config/logger';
import prisma from "../../config/db";
import * as ExcelJS from "exceljs";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { Prisma } from "@prisma/client";
import { parseLocalDate } from "../../utils/date.utils";

class DashboardAccessDeniedError extends Error {}

const responseStatusForDashboardError = (error: unknown) =>
  error instanceof DashboardAccessDeniedError ? 403 : 400;

const ACTIVE_SALE_STATUS_FILTER = { not: "CANCELLED" };

const parseDashboardDate = (value: unknown, endOfDay = false) => {
  if (value === undefined || value === null || value === "") return undefined;

  const rawDate = String(value);

  // YYYY-MM-DD strings must be parsed as local time, NOT as UTC midnight.
  // new Date("2026-05-26") = 2026-05-25T21:00 in UTC-3 → wrong day bug.
  let parsedDate: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    parsedDate = parseLocalDate(rawDate);
  } else {
    parsedDate = new Date(rawDate);
  }

  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error("El rango de fechas del dashboard no es valido.");
  }

  if (endOfDay) {
    parsedDate.setHours(23, 59, 59, 999);
  }

  return parsedDate;
};

const buildDashboardDateFilter = (from: unknown, to: unknown) => {
  const fromDate = parseDashboardDate(from);
  const toDate = parseDashboardDate(to, true);

  if (!fromDate && !toDate) return undefined;

  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("La fecha desde no puede ser posterior a la fecha hasta.");
  }

  return {
    ...(fromDate ? { gte: fromDate } : {}),
    ...(toDate ? { lte: toDate } : {}),
  };
};

const buildBranchFilter = (
  rawBranchId: unknown,
  authUser: { role: string; branchIds: number[] },
) => {
  const branchId = rawBranchId === undefined ? 0 : Number(rawBranchId);

  if (!Number.isInteger(branchId) || branchId < 0) {
    throw new Error("La sucursal del dashboard no es valida.");
  }

  if (branchId === 0) {
    if (authUser.role === "ADMIN") return undefined;
    throw new DashboardAccessDeniedError(
      "Solo un administrador puede consultar el consolidado de todas las sucursales.",
    );
  }

  if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
    throw new DashboardAccessDeniedError(
      "No tienes acceso a la sucursal solicitada.",
    );
  }

  return branchId;
};

/**
 * GET /dashboard/summary
 *
 * Returns the main KPI snapshot used by the home dashboard:
 * - totals (billed, collected, debt, expenses, cost)
 * - payment method breakdown
 * - expense category breakdown
 * - recent sales (last 10)
 * - open cash registers per branch
 * - stock alerts (critical / warning)
 * - top-selling products
 *
 * Access: ADMIN (all branches or filtered), ENCARGADO/EMPLOYEE (own branch only).
 *
 * @query branchId - 0 for consolidated view (ADMIN only), or a specific branch ID.
 * @query from     - Start date `YYYY-MM-DD` (inclusive, local time).
 * @query to       - End date `YYYY-MM-DD` (inclusive, end of day, local time).
 */
export const getDashboardSummary = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { branchId, from, to } = req.query;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const branchFilter = buildBranchFilter(branchId, authUser);
    const createdAt = buildDashboardDateFilter(from, to);
    const branchWhere =
      branchFilter === undefined ? {} : { branchId: branchFilter };
    const saleWhere: Prisma.SaleWhereInput = {
      ...branchWhere,
      status: ACTIVE_SALE_STATUS_FILTER,
      ...(createdAt ? { createdAt } : {}),
    };
    const paymentWhere: Prisma.PaymentWhereInput = {
      ...branchWhere,
      sale: { status: ACTIVE_SALE_STATUS_FILTER },
      ...(createdAt ? { createdAt } : {}),
    };
    const expenseWhere: Prisma.ExpenseWhereInput = {
      ...branchWhere,
      ...(createdAt ? { createdAt } : {}),
    };
    const stockWhere: Prisma.StockWhereInput | undefined =
      branchFilter === undefined ? undefined : { branchId: branchFilter };

    // Safety cap: prevent out-of-memory crashes on large datasets.
    // Date filters applied by the UI keep the typical result well below this threshold.
    const QUERY_LIMIT = 10_000;

    const [sales, payments, expenses, stocks, openCashRegisters] =
      await Promise.all([
      prisma.sale.findMany({
        where: saleWhere,
        take: QUERY_LIMIT,
        include: {
          branch: { select: { id: true, name: true } },
          customer: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
          items: {
            include: {
              product: {
                select: { id: true, name: true, sku: true, brand: true, category: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.payment.findMany({ where: paymentWhere, take: QUERY_LIMIT }),
      prisma.expense.findMany({ where: expenseWhere, take: QUERY_LIMIT }),
      prisma.stock.findMany({
        where: stockWhere,
        take: 5_000,
        include: {
          product: { select: { id: true, name: true, sku: true, brand: true } },
          branch: { select: { id: true, name: true } },
        },
      }),
      prisma.cashRegister.findMany({
        where: {
          ...(branchFilter === undefined ? {} : { branchId: branchFilter }),
          status: "OPEN",
        },
        include: {
          branch: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
        },
        orderBy: { openingTime: "desc" },
      }),
    ]);

    const totalBilled = sales.reduce((sum, sale) => sum + sale.totalAmount, 0);
    const totalDebt = sales.reduce((sum, sale) => sum + sale.balance, 0);
    const totalCollected = payments.reduce(
      (sum, payment) => sum + payment.amount,
      0,
    );
    const totalExpenses = expenses.reduce(
      (sum, expense) => sum + expense.amount,
      0,
    );
    const totalCost = sales.reduce((saleSum, sale) => {
      const itemsCost = sale.items.reduce(
        (itemSum, item) => itemSum + Number(item.unitCost || 0) * item.quantity,
        0,
      );
      return saleSum + itemsCost;
    }, 0);
    const stockAlerts = stocks.filter(
      (stock) => stock.quantity <= stock.minStock,
    );
    const criticalStockAlerts = stockAlerts.filter(
      (stock) => stock.quantity <= stock.criticalStock,
    );
    const warningStockAlerts = stockAlerts.filter(
      (stock) => stock.quantity > stock.criticalStock,
    );

    const paymentBreakdown = payments.reduce<Record<string, number>>(
      (breakdown, payment) => {
        const method = payment.paymentMethod.toUpperCase();
        breakdown[method] = (breakdown[method] || 0) + payment.amount;
        return breakdown;
      },
      {},
    );

    const expenseBreakdown = expenses.reduce<Record<string, number>>(
      (breakdown, expense) => {
        const category = expense.category.toUpperCase();
        breakdown[category] = (breakdown[category] || 0) + expense.amount;
        return breakdown;
      },
      {},
    );

    const topProductsMap = new Map<
      number,
      {
        productId: number;
        name: string;
        sku: string;
        brand: string;
        category: string;
        units: number;
        revenue: number;
        estimatedCost: number;
      }
    >();

    // Category profitability breakdown: revenue and margin per product category
    const categoryMap = new Map<string, { revenue: number; cost: number }>();

    sales.forEach((sale) => {
      sale.items.forEach((item) => {
        const product = item.product;
        const current = topProductsMap.get(item.productId) || {
          productId: item.productId,
          name: product.name,
          sku: product.sku,
          brand: product.brand,
          category: product.category || "Sin categoría",
          units: 0,
          revenue: 0,
          estimatedCost: 0,
        };

        current.units += item.quantity;
        current.revenue += item.subtotal;
        current.estimatedCost += Number(item.unitCost || 0) * item.quantity;
        topProductsMap.set(item.productId, current);

        // Accumulate category stats
        const cat = product.category || "Sin categoría";
        const catCurrent = categoryMap.get(cat) || { revenue: 0, cost: 0 };
        catCurrent.revenue += item.subtotal;
        catCurrent.cost += Number(item.unitCost || 0) * item.quantity;
        categoryMap.set(cat, catCurrent);
      });
    });

    const categoryBreakdown = Array.from(categoryMap.entries())
      .map(([category, { revenue, cost }]) => ({
        category,
        revenue,
        estimatedCost: cost,
        margin: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 100) : 0,
      }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8);

    const topProducts = Array.from(topProductsMap.values())
      .sort((a, b) => b.revenue - a.revenue || b.units - a.units)
      .slice(0, 8);
    const recentSales = sales.slice(0, 8).map((sale) => ({
      id: sale.id,
      totalAmount: sale.totalAmount,
      balance: sale.balance,
      status: sale.status,
      paymentMethod: sale.paymentMethod,
      customerName: sale.customer?.name || "Consumidor final",
      branchName: sale.branch.name,
      createdAt: sale.createdAt,
    }));

    // Group sales by calendar day for the trend chart (reuses the already-fetched sales array).
    const salesByDayMap = new Map<string, { total: number; count: number }>();
    for (const sale of sales) {
      const day = sale.createdAt.toISOString().slice(0, 10); // "YYYY-MM-DD"
      const existing = salesByDayMap.get(day) ?? { total: 0, count: 0 };
      salesByDayMap.set(day, {
        total: existing.total + sale.totalAmount,
        count: existing.count + 1,
      });
    }
    const salesByDay = Array.from(salesByDayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, { total, count }]) => ({ date, total, count }));

    // Group sales by seller — user data is already included in the sales join above.
    const sellerMap = new Map<
      number,
      { userId: number; userName: string; total: number; count: number }
    >();
    for (const sale of sales) {
      if (!sale.user) continue;
      const existing = sellerMap.get(sale.userId) ?? {
        userId: sale.userId,
        userName: sale.user.name,
        total: 0,
        count: 0,
      };
      sellerMap.set(sale.userId, {
        ...existing,
        total: existing.total + sale.totalAmount,
        count: existing.count + 1,
      });
    }
    const salesBySeller = Array.from(sellerMap.values())
      .sort((a, b) => b.total - a.total);

    res.status(200).json({
      scope: {
        branchId: branchId || "ALL",
        from: createdAt?.gte || null,
        to: createdAt?.lte || null,
      },
      kpis: {
        totalBilled,
        totalCollected,
        totalDebt,
        totalExpenses,
        grossProfit: totalBilled - totalCost,
        netProfit: totalBilled - totalCost - totalExpenses,
        stockAlerts: stockAlerts.length,
        criticalStockAlerts: criticalStockAlerts.length,
        warningStockAlerts: warningStockAlerts.length,
        salesCount: sales.length,
        openCashRegisters: openCashRegisters.length,
      },
      stockAlerts: stockAlerts.slice(0, 50),
      inventoryHealth: {
        critical: criticalStockAlerts.slice(0, 20),
        warning: warningStockAlerts.slice(0, 20),
        healthyCount: Math.max(stocks.length - stockAlerts.length, 0),
      },
      paymentBreakdown,
      expenseBreakdown,
      topProducts,
      categoryBreakdown,
      recentSales,
      salesByDay,
      salesBySeller,
      openCashRegisters: openCashRegisters.slice(0, 10).map((cashRegister) => ({
        id: cashRegister.id,
        branchId: cashRegister.branchId,
        branchName: cashRegister.branch.name,
        userName: cashRegister.user.name,
        initialBalance: cashRegister.initialBalance,
        openingTime: cashRegister.openingTime,
      })),
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo generar el resumen del dashboard.";
    res
      .status(responseStatusForDashboardError(error))
      .json({ error: errorMsg });
  }
};

// ============================================================================
// FINANCIAL ENGINE: General Profitability Summary
// ============================================================================

/**
 * GET /dashboard/financial-summary
 *
 * Returns gross revenue, collected payments, outstanding balance, total expenses,
 * estimated cost-of-goods, and gross margin for the requested branch/date range.
 *
 * @query branchId  - Optional branch filter.
 * @query startDate - Start of range (ISO string).
 * @query endDate   - End of range (ISO string).
 */
export const getFinancialSummary = async (req: Request, res: Response) => {
  try {
    const { branchId, startDate, endDate } = req.query;

    const saleWhereClause: Prisma.SaleWhereInput = {
      status: ACTIVE_SALE_STATUS_FILTER,
    };
    const expenseWhereClause: Prisma.ExpenseWhereInput = {};

    if (branchId) {
      saleWhereClause.branchId = Number(branchId);
      expenseWhereClause.branchId = Number(branchId);
    }

    if (startDate || endDate) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (startDate) createdAt.gte = new Date(String(startDate));
      if (endDate) createdAt.lte = new Date(String(endDate));
      saleWhereClause.createdAt = createdAt;
      expenseWhereClause.createdAt = createdAt;
    }

    const [sales, expenses] = await Promise.all([
      prisma.sale.findMany({
        where: saleWhereClause,
        take: 10_000,
        include: { items: true, payments: true },
      }),
      prisma.expense.findMany({
        where: expenseWhereClause,
        take: 10_000,
      }),
    ]);

    let totalBilled = 0;
    let totalCOGS = 0;
    let totalDebt = 0;
    const paymentMethods: Record<string, number> = {};

    sales.forEach((sale) => {
      totalBilled += sale.totalAmount;
      totalDebt += sale.balance;

      sale.items.forEach((item) => {
        const cost = item.unitCost ? item.unitCost : 0;
        totalCOGS += cost * item.quantity;
      });

      sale.payments.forEach((payment) => {
        const method = payment.paymentMethod.toUpperCase();
        if (!paymentMethods[method]) paymentMethods[method] = 0;
        paymentMethods[method] += payment.amount;
      });
    });

    const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);

    const grossProfit = totalBilled - totalCOGS;
    const netProfit = grossProfit - totalExpenses;
    const netMarginPercentage =
      totalBilled > 0 ? (netProfit / totalBilled) * 100 : 0;

    res.status(200).json({
      message: "Análisis Financiero procesado con éxito.",
      filters: {
        branchId: branchId || "ALL",
        startDate: startDate || "ALL",
        endDate: endDate || "ALL",
      },
      kpis: {
        totalBilled,
        totalDebt,
        totalCOGS,
        totalExpenses,
        grossProfit,
        netProfit,
        netMarginPercentage: Number(netMarginPercentage.toFixed(2)),
      },
      paymentBreakdown: paymentMethods,
    });
  } catch (error) {
    logger.error("Financial engine error:", error);
    res.status(500).json({
      error: "Fallo estructural al procesar las métricas financieras.",
    });
  }
};

// ============================================================================
// EXPENSE ENGINE: Operational and Payroll Analytics
// ============================================================================

/**
 * GET /dashboard/expenses-analytics
 *
 * Returns total expenses, a per-category breakdown, and a daily time-series
 * for the requested branch/date range.
 *
 * @query branchId  - Optional branch filter.
 * @query startDate - Start of range (ISO string).
 * @query endDate   - End of range (ISO string).
 */
export const getExpensesAnalytics = async (req: Request, res: Response) => {
  try {
    const { branchId, startDate, endDate } = req.query;

    const whereClause: Prisma.ExpenseWhereInput = {};
    if (branchId) whereClause.branchId = Number(branchId);

    if (startDate || endDate) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (startDate) createdAt.gte = new Date(String(startDate));
      if (endDate) createdAt.lte = new Date(String(endDate));
      whereClause.createdAt = createdAt;
    }

    const expenses = await prisma.expense.findMany({
      where: whereClause,
      include: { user: { select: { name: true, role: true } } },
    });

    const PAYROLL_CATEGORIES = [
      "SUELDO",
      "SUELDOS",
      "SALARIO",
      "HONORARIOS",
      "PERSONAL",
      "ADELANTO",
    ];

    let totalPayroll = 0;
    let totalOperational = 0;
    const operationalBreakdown: Record<string, number> = {};
    const payrollBreakdown: Record<string, number> = {};

    expenses.forEach((exp) => {
      const category = exp.category.toUpperCase().trim();

      if (PAYROLL_CATEGORIES.includes(category)) {
        totalPayroll += exp.amount;
        const reasonKey = exp.reason.toUpperCase();
        if (!payrollBreakdown[reasonKey]) payrollBreakdown[reasonKey] = 0;
        payrollBreakdown[reasonKey] += exp.amount;
      } else {
        totalOperational += exp.amount;
        if (!operationalBreakdown[category]) operationalBreakdown[category] = 0;
        operationalBreakdown[category] += exp.amount;
      }
    });

    let topExpenseCategory = "NINGUNO";
    let maxExpenseAmount = 0;

    for (const [category, amount] of Object.entries(operationalBreakdown)) {
      if (amount > maxExpenseAmount) {
        maxExpenseAmount = amount;
        topExpenseCategory = category;
      }
    }

    res.status(200).json({
      message: "Análisis de Gastos procesado con éxito.",
      filters: {
        branchId: branchId || "ALL",
        startDate: startDate || "ALL",
        endDate: endDate || "ALL",
      },
      kpis: { totalCombinedExpenses: totalPayroll + totalOperational },
      operational: {
        totalAmount: totalOperational,
        warningTopExpense: {
          category: topExpenseCategory,
          amount: maxExpenseAmount,
          percentageOfOperational:
            totalOperational > 0
              ? Number(((maxExpenseAmount / totalOperational) * 100).toFixed(2))
              : 0,
        },
        chartData: operationalBreakdown,
      },
      payroll: {
        totalAmount: totalPayroll,
        chartData: payrollBreakdown,
      },
    });
  } catch (error) {
    logger.error("Expense engine error:", error);
    res.status(500).json({
      error: "Fallo estructural al procesar las analíticas de gastos.",
    });
  }
};

// ============================================================================
// INVENTORY ENGINE: Sales Ranking and Stock Alert Traffic Light
// ============================================================================

/**
 * GET /dashboard/products-analytics
 *
 * Returns:
 * - top-selling products ranked by units sold (default top 10)
 * - stock alert traffic light: critical (≤ criticalStock) and warning (≤ minStock) items
 *
 * @query branchId  - Optional branch filter.
 * @query startDate - Start of range (ISO string).
 * @query endDate   - End of range (ISO string).
 * @query limit     - Max products in the ranking (default: 10).
 */
export const getProductsAnalytics = async (req: Request, res: Response) => {
  try {
    const { branchId, startDate, endDate, limit } = req.query;

    const rankingLimit = limit ? Number(limit) : 10;

    const saleWhereClause: Prisma.SaleWhereInput = { status: ACTIVE_SALE_STATUS_FILTER };
    if (branchId) saleWhereClause.branchId = Number(branchId);
    if (startDate || endDate) {
      const createdAt: Prisma.DateTimeFilter = {};
      if (startDate) createdAt.gte = new Date(String(startDate));
      if (endDate) createdAt.lte = new Date(String(endDate));
      saleWhereClause.createdAt = createdAt;
    }

    const topItemsData = await prisma.saleItem.groupBy({
      by: ["productId"],
      _sum: { quantity: true },
      where: { sale: saleWhereClause },
      orderBy: { _sum: { quantity: "desc" } },
      take: rankingLimit,
    });

    const topSellingProducts = await Promise.all(
      topItemsData.map(async (item) => {
        const product = await prisma.product.findUnique({
          where: { id: item.productId },
          select: { name: true, sku: true, brand: true, category: true },
        });
        return {
          ...product,
          totalUnitsSold: item._sum.quantity,
        };
      }),
    );

    const stockWhereClause = branchId ? { branchId: Number(branchId) } : {};
    const currentInventory = await prisma.stock.findMany({
      where: stockWhereClause,
      include: {
        product: { select: { name: true, sku: true, brand: true } },
        branch: { select: { name: true } },
      },
    });

    interface StockAlertEntry {
      branchName: string;
      productName: string;
      sku: string;
      currentQuantity: number;
      minimumRequired: number;
      criticalLevel: number;
    }
    const stockAlerts: { critical: StockAlertEntry[]; warning: StockAlertEntry[]; healthy: StockAlertEntry[] } = {
      critical: [],
      warning: [],
      healthy: [],
    };

    currentInventory.forEach((stock) => {
      const stockInfo = {
        branchName: stock.branch.name,
        productName: stock.product.name,
        sku: stock.product.sku,
        currentQuantity: stock.quantity,
        minimumRequired: stock.minStock,
        criticalLevel: stock.criticalStock,
      };

      if (stock.quantity <= stock.criticalStock)
        stockAlerts.critical.push(stockInfo);
      else if (stock.quantity <= stock.minStock)
        stockAlerts.warning.push(stockInfo);
      else stockAlerts.healthy.push(stockInfo);
    });

    res.status(200).json({
      message: "Análisis Logístico y Comercial procesado con éxito.",
      filters: {
        branchId: branchId || "ALL",
        startDate: startDate || "ALL",
        endDate: endDate || "ALL",
        rankingLimit,
      },
      salesRanking: topSellingProducts,
      inventoryHealth: {
        criticalCount: stockAlerts.critical.length,
        warningCount: stockAlerts.warning.length,
        healthyCount: stockAlerts.healthy.length,
        details: stockAlerts,
      },
    });
  } catch (error) {
    logger.error("Inventory engine error:", error);
    res.status(500).json({
      error: "Fallo estructural al generar las estadísticas de catálogo.",
    });
  }
};

// ============================================================================
// CREDIT RISK ENGINE: Debtor Analysis and Aging
// ============================================================================

/**
 * GET /dashboard/credit-risk
 *
 * Returns an aging report for all open receivables (PENDING / PARTIAL sales):
 * - per-debtor summary (total debt, days overdue)
 * - aging buckets: current (≤7d), at-risk (8–30d), overdue (31–90d), critical (>90d)
 * - total capital on street
 *
 * Access: ADMIN only (no branch filter — consolidated view).
 */
export const getCreditRiskAnalytics = async (req: Request, res: Response) => {
  try {
    const pendingSales = await prisma.sale.findMany({
      where: {
        status: { in: ["PENDING", "PARTIAL"] },
        customerId: { not: null },
      },
      include: {
        customer: { select: { name: true, document: true, phone: true } },
      },
    });

    let totalCapitalOnStreet = 0;
    interface DebtorEntry {
      customerId: number;
      name: string | null | undefined;
      phone: string | null | undefined;
      totalDebt: number;
      oldestInvoiceDate: Date;
    }
    const debtorsMap: Record<number, DebtorEntry> = {};
    let overdueInvoicesCount = 0;

    const overdueThreshold = new Date();
    overdueThreshold.setDate(overdueThreshold.getDate() - 30);

    pendingSales.forEach((sale) => {
      totalCapitalOnStreet += sale.balance;

      if (sale.createdAt < overdueThreshold) overdueInvoicesCount++;

      const customerId = sale.customerId as number;
      if (!debtorsMap[customerId]) {
        debtorsMap[customerId] = {
          customerId: customerId,
          name: sale.customer?.name,
          phone: sale.customer?.phone,
          totalDebt: 0,
          oldestInvoiceDate: sale.createdAt,
        };
      }

      debtorsMap[customerId].totalDebt += sale.balance;

      if (sale.createdAt < debtorsMap[customerId].oldestInvoiceDate) {
        debtorsMap[customerId].oldestInvoiceDate = sale.createdAt;
      }
    });

    const topDebtorsRanking = Object.values(debtorsMap).sort(
      (a, b) => b.totalDebt - a.totalDebt,
    );

    res.status(200).json({
      message: "Análisis de Riesgo Crediticio generado con éxito.",
      kpis: {
        totalCapitalOnStreet,
        activeDebtorsCount: topDebtorsRanking.length,
        overdueInvoicesCount,
      },
      topDebtorsRanking: topDebtorsRanking.slice(0, 20),
    });
  } catch (error) {
    logger.error("Credit risk engine error:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al calcular métricas de deuda." });
  }
};

// ============================================================================
// ACCOUNTING EXPORT: Excel Report Generator
// ============================================================================

/**
 * GET /dashboard/export-excel
 *
 * Streams an Excel (.xlsx) file with all PAID sales (id, date, customer,
 * items, subtotals). No branch/date filter — full history export.
 *
 * @deprecated Use `exportScopedFinancialReportToExcel` for filtered, role-aware exports.
 */
export const exportFinancialReportToExcel = async (
  req: Request,
  res: Response,
) => {
  try {
    const sales = await prisma.sale.findMany({
      where: { status: "PAID" }, // Export only confirmed paid transactions
      include: { customer: true, items: true },
      orderBy: { createdAt: "desc" },
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Reporte de Ventas");

    // Column schema
    worksheet.columns = [
      { header: "Fecha", key: "date", width: 15 },
      { header: "Nº Ticket", key: "id", width: 10 },
      { header: "Cliente", key: "customer", width: 25 },
      { header: "Medio de Pago", key: "method", width: 15 },
      { header: "Total Facturado", key: "total", width: 15 },
    ];

    // Row population
    sales.forEach((sale) => {
      worksheet.addRow({
        date: sale.createdAt.toLocaleDateString("es-AR"),
        id: sale.id,
        customer: sale.customer?.name || "Consumidor Final",
        method: sale.paymentMethod,
        total: sale.totalAmount,
      });
    });

    // Set HTTP headers to force file download
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=Reporte_Contable_ElClub.xlsx",
    );

    // Stream binary workbook to response
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logger.error("Excel export error:", error);
    res
      .status(500)
      .json({ error: "Fallo en la generación del documento contable." });
  }
};

/**
 * GET /dashboard/export-scoped-excel
 *
 * Role-aware version of the financial export. Streams an Excel file filtered
 * by branch and date range. Respects the caller's branch access.
 *
 * Sheets: Sales, Payments, Expenses.
 *
 * Access: ADMIN (all branches), ENCARGADO/EMPLOYEE (own branch only).
 *
 * @query branchId - 0 for all branches (ADMIN only) or a specific branch ID.
 * @query from     - Start date `YYYY-MM-DD` (local time).
 * @query to       - End date `YYYY-MM-DD` (local time, end of day).
 */
export const exportScopedFinancialReportToExcel = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const { branchId, from, to } = req.query;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const branchFilter = buildBranchFilter(branchId, authUser);
    const createdAt = buildDashboardDateFilter(from, to);
    const branchWhere =
      branchFilter === undefined ? {} : { branchId: branchFilter };
    const saleWhere: Prisma.SaleWhereInput = {
      ...branchWhere,
      status: ACTIVE_SALE_STATUS_FILTER,
      ...(createdAt ? { createdAt } : {}),
    };
    const paymentWhere: Prisma.PaymentWhereInput = {
      ...branchWhere,
      sale: { status: ACTIVE_SALE_STATUS_FILTER },
      ...(createdAt ? { createdAt } : {}),
    };
    const expenseWhere: Prisma.ExpenseWhereInput = {
      ...branchWhere,
      ...(createdAt ? { createdAt } : {}),
    };

    const [sales, payments, expenses] = await Promise.all([
      prisma.sale.findMany({
        where: saleWhere,
        include: {
          branch: { select: { id: true, name: true } },
          customer: { select: { id: true, name: true, document: true } },
          items: {
            include: {
              product: {
                select: { id: true, name: true, sku: true, brand: true, category: true },
              },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.payment.findMany({
        where: paymentWhere,
        include: {
          branch: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
          sale: { select: { id: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      prisma.expense.findMany({
        where: expenseWhere,
        include: {
          branch: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
    ]);

    const totalBilled = sales.reduce((sum, sale) => sum + sale.totalAmount, 0);
    const totalCollected = payments.reduce(
      (sum, payment) => sum + payment.amount,
      0,
    );
    const totalExpenses = expenses.reduce(
      (sum, expense) => sum + expense.amount,
      0,
    );
    const totalDebt = sales.reduce((sum, sale) => sum + sale.balance, 0);
    const totalCost = sales.reduce(
      (saleSum, sale) =>
        saleSum +
        sale.items.reduce(
          (itemSum, item) =>
            itemSum + Number(item.unitCost || 0) * item.quantity,
          0,
        ),
      0,
    );

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "El Club de la Pintura ERP";
    workbook.created = new Date();

    const summarySheet = workbook.addWorksheet("Resumen");
    summarySheet.columns = [
      { header: "Indicador", key: "metric", width: 34 },
      { header: "Valor", key: "value", width: 24 },
    ];
    summarySheet.addRows([
      { metric: "Sucursal", value: branchId || "ALL" },
      { metric: "Desde", value: createdAt?.gte || "ALL" },
      { metric: "Hasta", value: createdAt?.lte || "ALL" },
      { metric: "Ventas", value: sales.length },
      { metric: "Facturado", value: totalBilled },
      { metric: "Cobrado", value: totalCollected },
      { metric: "Deuda", value: totalDebt },
      { metric: "Costo estimado", value: totalCost },
      { metric: "Gastos", value: totalExpenses },
      {
        metric: "Resultado neto",
        value: totalBilled - totalCost - totalExpenses,
      },
    ]);

    const salesSheet = workbook.addWorksheet("Ventas");
    salesSheet.columns = [
      { header: "Fecha", key: "date", width: 20 },
      { header: "Ticket", key: "id", width: 10 },
      { header: "Sucursal", key: "branch", width: 24 },
      { header: "Cliente", key: "customer", width: 28 },
      { header: "Estado", key: "status", width: 14 },
      { header: "Medio de Pago", key: "method", width: 16 },
      { header: "Total Facturado", key: "total", width: 16 },
      { header: "Saldo", key: "balance", width: 16 },
      { header: "Costo Estimado", key: "cost", width: 16 },
      { header: "Margen Bruto", key: "grossProfit", width: 16 },
      { header: "Items", key: "items", width: 60 },
    ];

    sales.forEach((sale) => {
      const estimatedCost = sale.items.reduce(
        (sum, item) => sum + Number(item.unitCost || 0) * item.quantity,
        0,
      );
      salesSheet.addRow({
        date: sale.createdAt,
        id: sale.id,
        branch: sale.branch.name,
        customer: sale.customer?.name || "Consumidor Final",
        status: sale.status,
        method: sale.paymentMethod,
        total: sale.totalAmount,
        balance: sale.balance,
        cost: estimatedCost,
        grossProfit: sale.totalAmount - estimatedCost,
        items: sale.items
          .map(
            (item) =>
              `${item.quantity} x ${item.product.name} (${item.product.sku})`,
          )
          .join("; "),
      });
    });

    const paymentsSheet = workbook.addWorksheet("Cobranzas");
    paymentsSheet.columns = [
      { header: "Fecha", key: "date", width: 20 },
      { header: "ID", key: "id", width: 10 },
      { header: "Sucursal", key: "branch", width: 24 },
      { header: "Ticket", key: "saleId", width: 10 },
      { header: "Usuario", key: "user", width: 24 },
      { header: "Medio", key: "method", width: 16 },
      { header: "Monto", key: "amount", width: 16 },
    ];
    payments.forEach((payment) => {
      paymentsSheet.addRow({
        date: payment.createdAt,
        id: payment.id,
        branch: payment.branch.name,
        saleId: payment.sale.id,
        user: payment.user.name,
        method: payment.paymentMethod,
        amount: payment.amount,
      });
    });

    const expensesSheet = workbook.addWorksheet("Gastos");
    expensesSheet.columns = [
      { header: "Fecha", key: "date", width: 20 },
      { header: "ID", key: "id", width: 10 },
      { header: "Sucursal", key: "branch", width: 24 },
      { header: "Usuario", key: "user", width: 24 },
      { header: "Categoria", key: "category", width: 18 },
      { header: "Tipo", key: "type", width: 14 },
      { header: "Motivo", key: "reason", width: 40 },
      { header: "Monto", key: "amount", width: 16 },
    ];
    expenses.forEach((expense) => {
      expensesSheet.addRow({
        date: expense.createdAt,
        id: expense.id,
        branch: expense.branch.name,
        user: expense.user.name,
        category: expense.category,
        type: expense.type,
        reason: expense.reason,
        amount: expense.amount,
      });
    });

    [summarySheet, salesSheet, paymentsSheet, expensesSheet].forEach((sheet) => {
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: "frozen", ySplit: 1 }];
      sheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columnCount },
      };
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=Reporte_Contable_ElClub_${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`,
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: unknown) {
    logger.error("Error exportando a Excel:", error);
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Fallo en la generacion del documento contable.";
    res
      .status(responseStatusForDashboardError(error))
      .json({ error: errorMsg });
  }
};

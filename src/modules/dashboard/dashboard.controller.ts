import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// MOTOR FINANCIERO: Resumen General de Rentabilidad
// ============================================================================
export const getFinancialSummary = async (req: Request, res: Response) => {
  try {
    const { branchId, startDate, endDate } = req.query;

    const whereClause: any = {};
    if (branchId) whereClause.branchId = Number(branchId);

    if (startDate || endDate) {
      whereClause.createdAt = {};
      if (startDate) whereClause.createdAt.gte = new Date(String(startDate));
      if (endDate) whereClause.createdAt.lte = new Date(String(endDate));
    }

    const [sales, expenses] = await Promise.all([
      prisma.sale.findMany({
        where: whereClause,
        include: { items: true, payments: true },
      }),
      prisma.expense.findMany({
        where: whereClause,
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
    console.error("Error en Motor Financiero:", error);
    res.status(500).json({
      error: "Fallo estructural al procesar las métricas financieras.",
    });
  }
};

// ============================================================================
// MOTOR DE GASTOS: Análisis Operativo y de Nómina (Sueldos)
// ============================================================================
export const getExpensesAnalytics = async (req: Request, res: Response) => {
  try {
    const { branchId, startDate, endDate } = req.query;

    const whereClause: any = {};
    if (branchId) whereClause.branchId = Number(branchId);

    if (startDate || endDate) {
      whereClause.createdAt = {};
      if (startDate) whereClause.createdAt.gte = new Date(String(startDate));
      if (endDate) whereClause.createdAt.lte = new Date(String(endDate));
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
    console.error("Error en Motor de Gastos:", error);
    res.status(500).json({
      error: "Fallo estructural al procesar las analíticas de gastos.",
    });
  }
};

// ============================================================================
// MOTOR DE INVENTARIO: Ranking de Ventas y Semáforo de Alertas
// ============================================================================
export const getProductsAnalytics = async (req: Request, res: Response) => {
  try {
    const { branchId, startDate, endDate, limit } = req.query;

    const rankingLimit = limit ? Number(limit) : 10;

    const saleWhereClause: any = {};
    if (branchId) saleWhereClause.branchId = Number(branchId);
    if (startDate || endDate) {
      saleWhereClause.createdAt = {};
      if (startDate)
        saleWhereClause.createdAt.gte = new Date(String(startDate));
      if (endDate) saleWhereClause.createdAt.lte = new Date(String(endDate));
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

    const stockAlerts = {
      critical: [] as any[],
      warning: [] as any[],
      healthy: [] as any[],
    };

    // CLASIFICAR salud del inventario dinámicamente según `minStock` y `criticalStock`
    currentInventory.forEach((stock) => {
      const stockInfo = {
        branchName: stock.branch.name,
        productName: stock.product.name,
        sku: stock.product.sku,
        currentQuantity: stock.quantity,
        minimumRequired: stock.minStock,
        criticalLevel: stock.criticalStock, // Enviamos el límite crítico para que el Frontend lo vea
      };

      // Inyección: Lógica Matemática Dinámica para el semáforo
      if (stock.quantity <= stock.criticalStock) {
        stockAlerts.critical.push(stockInfo);
      } else if (stock.quantity <= stock.minStock) {
        stockAlerts.warning.push(stockInfo);
      } else {
        stockAlerts.healthy.push(stockInfo);
      }
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
    console.error("Error en Motor de Inventario:", error);
    res.status(500).json({
      error: "Fallo estructural al generar las estadísticas de catálogo.",
    });
  }
};

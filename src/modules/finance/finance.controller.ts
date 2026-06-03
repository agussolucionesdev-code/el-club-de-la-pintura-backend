/**
 * Finance Controller — legacy daily revenue and product ranking endpoints.
 *
 * @deprecated These endpoints predate the unified dashboard. Prefer the
 * `dashboard.controller` endpoints (`getDashboardSummary`, `getProductsAnalytics`)
 * which support branch scoping, date ranges, and role-based access control.
 *
 * @module finance.controller
 */
import { Request, Response } from "express";
import { logger } from '../../config/logger';
import prisma from "../../config/db";

/**
 * GET /finance/daily-revenue
 *
 * Returns today's financial snapshot: gross revenue (accrual), actual cash
 * collected (liquidity), total cost-of-goods, and net profit. Date range is
 * always the current calendar day (00:00–23:59 server local time).
 *
 * @deprecated Use `GET /dashboard/summary?from=YYYY-MM-DD&to=YYYY-MM-DD` instead.
 */
export const getDailyRevenue = async (req: Request, res: Response) => {
  try {
    // Define time range: From 00:00:00 to 23:59:59 of the current day
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // 1. Fetch all sales and their associated items (accrual accounting / invoiced amounts)
    const dailySales = await prisma.sale.findMany({
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
      include: {
        items: true,
      },
    });

    // 2. Fetch actual physical cash flow (Liquidity)
    // Groups all payments made today: deposits, cash sales, and collections on old debts
    const dailyPayments = await prisma.payment.aggregate({
      _sum: {
        amount: true,
      },
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    // Initialize financial accumulators
    let grossBilled = 0; // Total invoiced (including unpaid balances)
    let totalCost = 0;

    // Iterate through sales and items to aggregate financial data
    dailySales.forEach((sale) => {
      grossBilled += sale.totalAmount;

      sale.items.forEach((item) => {
        // Aggregate cost based on frozen historical unitCost
        const itemCost = item.unitCost ? item.unitCost : 0;
        totalCost += itemCost * item.quantity;
      });
    });

    // Extract actual physical cash entered today
    const actualCashFlow = dailyPayments._sum.amount || 0;

    // Calculate net profit and profit margin percentage based on billed amounts
    const netProfit = grossBilled - totalCost;
    const profitMarginPercentage =
      grossBilled > 0 ? (netProfit / grossBilled) * 100 : 0;

    // Send successful response with calculated financial metrics
    res.status(200).json({
      message: "Daily financial report and cash flow generated successfully.",
      date: startOfDay.toISOString().split("T")[0],
      metrics: {
        grossBilled, // Total value of merchandise sold today
        actualCashFlow, // Physical money entered in the drawer today
        totalCost, // Total frozen cost of the merchandise sold
        netProfit, // Expected profit once all debts are paid
        profitMarginPercentage: Number(profitMarginPercentage.toFixed(2)),
      },
    });
  } catch (error) {
    logger.error("Error calculating daily revenue:", error);
    res.status(500).json({
      error: "Structural failure while processing financial metrics.",
    });
  }
};

// Retrieve top selling products
// Group billing rows (SaleItem) to identify star items
/**
 * GET /finance/top-products
 *
 * Returns the top-N products by units sold for the current month.
 *
 * @deprecated Use `GET /dashboard/products-analytics` instead, which supports
 * branch scoping, arbitrary date ranges, and revenue/margin breakdown.
 *
 * @query limit - Number of products to return (default: 5).
 */
export const getTopSellingProducts = async (req: Request, res: Response) => {
  try {
    const { limit = 5 } = req.query;

    // Group and sum sold quantities by product ID
    const topItems = await prisma.saleItem.groupBy({
      by: ["productId"],
      _sum: {
        quantity: true,
      },
      orderBy: {
        _sum: {
          quantity: "desc",
        },
      },
      take: Number(limit),
    });

    // Batch-fetch all product details in a single query (avoids N+1)
    const productIds = topItems.map((item) => item.productId);
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, sku: true, category: true },
    });
    const productMap = new Map(products.map((p) => [p.id, p]));

    const productsWithDetails = topItems.map((item) => {
      const product = productMap.get(item.productId);
      return {
        name: product?.name ?? null,
        sku: product?.sku ?? null,
        category: product?.category ?? null,
        totalSold: item._sum.quantity,
      };
    });

    // Send successful response with top products array
    res.status(200).json({
      message: "Sales ranking generated successfully.",
      topProducts: productsWithDetails,
    });
  } catch (error) {
    logger.error("Error calculating top products:", error);
    res.status(500).json({
      error: "Failure while generating inventory rotation metrics.",
    });
  }
};

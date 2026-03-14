import { Request, Response } from "express";
import prisma from "../../config/db";

// Retrieve daily financial metrics
// Calculate gross revenue, total costs, and net profit for the current day
export const getDailyRevenue = async (req: Request, res: Response) => {
  try {
    // Define time range: From 00:00:00 to 23:59:59 of the current day
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // Fetch all sales and their associated items within the time range
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

    // Initialize financial accumulators
    let totalRevenue = 0;
    let totalCost = 0;

    // Iterate through sales and items to aggregate financial data
    dailySales.forEach((sale) => {
      totalRevenue += sale.totalAmount;

      sale.items.forEach((item) => {
        // Aggregate cost based on frozen historical unitCost
        const itemCost = item.unitCost ? item.unitCost : 0;
        totalCost += itemCost * item.quantity;
      });
    });

    // Calculate net profit and profit margin percentage
    const netProfit = totalRevenue - totalCost;
    const profitMarginPercentage =
      totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    // Send successful response with calculated financial metrics
    res.status(200).json({
      message: "Daily financial report generated successfully.",
      date: startOfDay.toISOString().split("T")[0],
      metrics: {
        totalRevenue,
        totalCost,
        netProfit,
        profitMarginPercentage: Number(profitMarginPercentage.toFixed(2)),
      },
    });
  } catch (error) {
    console.error("Error calculating daily revenue:", error);
    res.status(500).json({
      error: "Structural failure while processing financial metrics.",
    });
  }
};

// Retrieve top selling products
// Group billing rows (SaleItem) to identify star items
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

    // Map relational data to append product names and SKUs
    const productsWithDetails = await Promise.all(
      topItems.map(async (item) => {
        const product = await prisma.product.findUnique({
          where: { id: item.productId },
          select: { name: true, sku: true, category: true },
        });
        return {
          ...product,
          totalSold: item._sum.quantity,
        };
      }),
    );

    // Send successful response with top products array
    res.status(200).json({
      message: "Sales ranking generated successfully.",
      topProducts: productsWithDetails,
    });
  } catch (error) {
    console.error("Error calculating top products:", error);
    res.status(500).json({
      error: "Failure while generating inventory rotation metrics.",
    });
  }
};

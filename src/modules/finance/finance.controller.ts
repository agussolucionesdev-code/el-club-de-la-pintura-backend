import { Request, Response } from "express";
import prisma from "../../config/db";

// Obtención de métricas financieras diarias
// Calcula el ingreso bruto total generado en el día en curso
export const getDailyRevenue = async (req: Request, res: Response) => {
  try {
    // Definimos el rango de tiempo: Desde las 00:00:00 hasta las 23:59:59 de hoy
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // Motor analítico de Prisma: Suma totalAmount de los tickets generados hoy
    const dailySales = await prisma.sale.aggregate({
      _sum: {
        totalAmount: true,
      },
      where: {
        createdAt: {
          gte: startOfDay,
          lte: endOfDay,
        },
      },
    });

    const totalRevenue = dailySales._sum.totalAmount || 0;

    res.status(200).json({
      message: "Reporte financiero diario generado con éxito.",
      date: startOfDay.toISOString().split("T")[0],
      totalRevenue,
    });
  } catch (error) {
    console.error("Error al calcular los ingresos diarios:", error);
    res.status(500).json({
      error: "Fallo estructural al procesar las métricas financieras.",
    });
  }
};

// Obtención del top de productos más vendidos
// Agrupa los renglones de facturación (SaleItem) para identificar los artículos estrella
export const getTopSellingProducts = async (req: Request, res: Response) => {
  try {
    const { limit = 5 } = req.query;

    // Agrupación y sumatoria de cantidades vendidas por ID de producto
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

    // Mapeo relacional: búsqueda de los nombres y SKU de esos productos ganadores
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

    res.status(200).json({
      message: "Ranking de ventas generado exitosamente.",
      topProducts: productsWithDetails,
    });
  } catch (error) {
    console.error("Error al calcular el ranking de productos:", error);
    res.status(500).json({
      error: "Fallo al generar las métricas de rotación de inventario.",
    });
  }
};

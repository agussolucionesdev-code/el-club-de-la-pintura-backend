import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// 1. OBTENER HISTORIAL DE GASTOS (Esta función arregla el error 404)
// ============================================================================
export const getExpenses = async (req: Request, res: Response) => {
  try {
    const expenses = await prisma.expense.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        user: { select: { name: true } }, // Traemos el nombre de quien cargó el gasto
      },
    });

    res.status(200).json({
      message: "Libro diario de egresos recuperado exitosamente.",
      data: expenses,
    });
  } catch (error: any) {
    console.error("Error al obtener gastos:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al procesar el historial de gastos." });
  }
};

// ============================================================================
// 2. REGISTRAR GASTO: Declarar retiro de dinero físico del mostrador
// ============================================================================
export const registerExpense = async (req: Request, res: Response) => {
  try {
    const { amount, reason, category, type, branchId, cashRegisterId } =
      req.body;
    const authUser = (req as any).user;
    const withdrawalAmount = Number(amount);

    if (!cashRegisterId) {
      return res.status(400).json({
        error: "Fallo de conexión: No se identificó la caja registradora.",
      });
    }

    // Ejecutar validación de seguridad Multi-Branch
    const userBranches = authUser.branchIds || [];
    if (authUser.role !== "ADMIN" && !userBranches.includes(Number(branchId))) {
      return res.status(403).json({
        error: "Brecha de seguridad: No tienes acceso a esta sucursal.",
      });
    }

    const transactionResult = await prisma.$transaction(async (tx) => {
      // 1. Buscar la caja exacta por su ID
      const activeShift = await tx.cashRegister.findUnique({
        where: { id: Number(cashRegisterId) },
      });

      if (!activeShift || activeShift.status !== "OPEN") {
        throw new Error(
          "Operación denegada: La caja registradora se encuentra cerrada.",
        );
      }

      // 🛡️ 2. LÓGICA DE FONDOS INSUFICIENTES (El verdadero Poka-Yoke)
      // Soporta tanto 'expectedBalance' como 'currentExpectedBalance' según tu base de datos
      const currentCashInDrawer =
        activeShift.expectedBalance !== undefined
          ? activeShift.expectedBalance
          : (activeShift as any).currentExpectedBalance || 0;

      if (withdrawalAmount > currentCashInDrawer) {
        throw new Error(
          `🛑 FONDOS INSUFICIENTES: La caja dispone de $${currentCashInDrawer.toLocaleString("es-AR")}. Es físicamente imposible retirar $${withdrawalAmount.toLocaleString("es-AR")}.`,
        );
      }

      // 3. Registrar la salida de dinero
      const newExpense = await tx.expense.create({
        data: {
          amount: withdrawalAmount,
          reason: reason,
          category: category,
          type: type || "VARIABLE",
          branchId: Number(branchId),
          userId: Number(authUser.id),
          cashRegisterId: activeShift.id,
        },
      });

      // 4. Actualizar el saldo de la caja restando el gasto
      await tx.cashRegister.update({
        where: { id: activeShift.id },
        data: {
          expectedBalance: currentCashInDrawer - withdrawalAmount,
        },
      });

      return newExpense;
    });

    res.status(201).json({
      message: "Gasto registrado. Saldo actualizado en tiempo real.",
      data: transactionResult,
    });
  } catch (error: any) {
    console.error("Error al registrar el gasto:", error);
    if (error instanceof Error) {
      // Devolvemos el error 400 exacto al frontend para que lo muestre el Toast
      return res.status(400).json({ error: error.message });
    }
    res
      .status(500)
      .json({ error: "Fallo estructural al procesar la salida de dinero." });
  }
};

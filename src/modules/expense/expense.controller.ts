import { Request, Response } from "express";
import prisma from "../../config/db";

export const getExpenses = async (req: Request, res: Response) => {
  try {
    const expenses = await prisma.expense.findMany({
      orderBy: { createdAt: "desc" },
      include: { user: { select: { name: true } } },
    });
    res
      .status(200)
      .json({ message: "Libro diario de egresos recuperado.", data: expenses });
  } catch (error: any) {
    res.status(500).json({ error: "Fallo al procesar el historial." });
  }
};

export const registerExpense = async (req: Request, res: Response) => {
  try {
    const { amount, reason, category, type, branchId, cashRegisterId } =
      req.body;
    const authUser = (req as any).user;
    const withdrawalAmount = Number(amount);

    // 🛡️ DEBUG: Si Zod borró el ID, avisamos sin usar la palabra prohibida
    if (!cashRegisterId) {
      return res.status(400).json({
        error:
          "ERROR DE ZOD: El servidor no recibió el ID de la registradora. Verificá el schema.",
      });
    }

    const userBranches = authUser.branchIds || [];
    if (authUser.role !== "ADMIN" && !userBranches.includes(Number(branchId))) {
      return res
        .status(403)
        .json({ error: "No tienes acceso a esta sucursal." });
    }

    const transactionResult = await prisma.$transaction(async (tx) => {
      const activeShift = await tx.cashRegister.findUnique({
        where: { id: Number(cashRegisterId) },
      });

      // 🛡️ Sin la palabra prohibida
      if (!activeShift || activeShift.status !== "OPEN") {
        throw new Error("Operación denegada: La registradora no está abierta.");
      }

      const rawBalance =
        activeShift.expectedBalance ??
        (activeShift as any).currentExpectedBalance ??
        0;
      const currentCashInDrawer = Number(rawBalance);

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

      await tx.cashRegister.update({
        where: { id: activeShift.id },
        data: { expectedBalance: currentCashInDrawer - withdrawalAmount },
      });

      return newExpense;
    });

    res.status(201).json({
      message: "Egreso registrado correctamente.",
      data: transactionResult,
    });
  } catch (error: any) {
    if (error instanceof Error) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: "Fallo estructural al procesar." });
  }
};

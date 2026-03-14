import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// REGISTRAR GASTO: Declarar retiro de dinero físico del mostrador
// ============================================================================
export const registerExpense = async (req: Request, res: Response) => {
  try {
    const { amount, reason, category, type, branchId } = req.body;
    const authUser = (req as any).user;

    // Ejecutar validación de seguridad Multi-Branch
    if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
      return res.status(403).json({
        error: "Brecha de seguridad: No tienes acceso a esta sucursal.",
      });
    }

    const transactionResult = await prisma.$transaction(async (tx) => {
      // 1. Verificar existencia de turno de caja abierto
      const activeShift = await tx.cashRegister.findFirst({
        where: { userId: authUser.id, branchId: branchId, status: "OPEN" },
      });

      if (!activeShift) {
        throw new Error(
          "Operación denegada: Debes tener un turno de caja abierto para registrar salidas de dinero.",
        );
      }

      // 2. Registrar salida de dinero con clasificación contable (FIXED/VARIABLE)
      const newExpense = await tx.expense.create({
        data: {
          amount: Number(amount),
          reason,
          category,
          type, // INYECCIÓN: Clasificación financiera estructural
          branchId,
          userId: authUser.id,
          cashRegisterId: activeShift.id,
        },
      });

      return newExpense;
    });

    res.status(201).json({
      message:
        "Gasto operativo registrado correctamente. El monto será descontado del cierre de caja.",
      expense: transactionResult,
    });
  } catch (error: any) {
    console.error("Error al registrar el gasto:", error);
    if (error instanceof Error) {
      return res.status(400).json({ error: error.message });
    }
    res
      .status(500)
      .json({ error: "Fallo estructural al procesar la salida de dinero." });
  }
};

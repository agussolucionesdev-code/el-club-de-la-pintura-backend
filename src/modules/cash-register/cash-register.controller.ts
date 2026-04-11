import { Response } from "express";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";

const calculateExpectedCashBalance = (shift: {
  initialBalance: number;
  payments: { amount: number; paymentMethod: string }[];
  expenses: { amount: number }[];
}) => {
  const totalCashPayments = shift.payments.reduce((acc, payment) => {
    return payment.paymentMethod.toUpperCase() === "CASH"
      ? acc + payment.amount
      : acc;
  }, 0);

  const totalExpenses = shift.expenses.reduce(
    (acc, expense) => acc + expense.amount,
    0,
  );

  return shift.initialBalance + totalCashPayments - totalExpenses;
};

export const getActiveShift = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.params.branchId);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del operador.",
      });
    }

    if (!Number.isInteger(branchId) || branchId <= 0) {
      return res.status(400).json({
        error: "La sucursal indicada no es valida.",
      });
    }

    const activeShift = await prisma.cashRegister.findFirst({
      where: {
        branchId,
        status: "OPEN",
      },
      include: {
        user: { select: { id: true, name: true } },
        expenses: true,
        payments: true,
      },
    });

    if (!activeShift) {
      return res.status(200).json({
        message: "No hay turnos abiertos.",
        data: null,
      });
    }

    const currentExpectedBalance = calculateExpectedCashBalance(activeShift);

    res.status(200).json({
      message: "Turno activo recuperado.",
      data: {
        ...activeShift,
        currentExpectedBalance,
      },
    });
  } catch (error: unknown) {
    console.error("Error al obtener estado de caja:", error);
    res
      .status(500)
      .json({ error: "Fallo de conexion al consultar el cajon de dinero." });
  }
};

export const openShift = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { initialBalance, branchId } = req.body;
    const parsedBranchId = Number(branchId);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del operador.",
      });
    }

    if (!Number.isInteger(parsedBranchId) || parsedBranchId <= 0) {
      return res.status(400).json({
        error: "La sucursal indicada no es valida.",
      });
    }

    if (
      authUser.role !== "ADMIN" &&
      !authUser.branchIds.includes(parsedBranchId)
    ) {
      return res.status(403).json({
        error: "No tienes acceso a la sucursal indicada.",
      });
    }

    const existingOpen = await prisma.cashRegister.findFirst({
      where: { branchId: parsedBranchId, status: "OPEN" },
    });

    if (existingOpen) {
      return res.status(400).json({
        error:
          "Atencion: Ya existe un turno abierto en esta sucursal. Debe cerrarlo antes de iniciar uno nuevo.",
      });
    }

    const newShift = await prisma.cashRegister.create({
      data: {
        initialBalance: Number(initialBalance),
        userId: authUser.id,
        branchId: parsedBranchId,
        status: "OPEN",
      },
    });

    res.status(201).json({
      message:
        "Caja abierta exitosamente. Que sea una excelente jornada de ventas.",
      data: newShift,
    });
  } catch (error: unknown) {
    console.error("Error critico al abrir caja:", error);
    res.status(500).json({
      error:
        "Fallo de integridad: Verifique que el usuario y la sucursal existan en la base de datos.",
    });
  }
};

export const closeShift = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { id } = req.params;
    const { actualBalance, observations } = req.body;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del operador.",
      });
    }

    const shift = await prisma.cashRegister.findUnique({
      where: { id: Number(id) },
      include: {
        payments: true,
        expenses: true,
      },
    });

    if (!shift || shift.status === "CLOSED") {
      return res.status(400).json({
        error: "El turno indicado no existe o ya fue cerrado previamente.",
      });
    }

    if (
      authUser.role !== "ADMIN" &&
      !authUser.branchIds.includes(shift.branchId)
    ) {
      return res.status(403).json({
        error: "No tienes acceso a la sucursal donde se abrio esta caja.",
      });
    }

    const expectedBalance = calculateExpectedCashBalance(shift);
    const discrepancy = Number(actualBalance) - expectedBalance;

    const result = await prisma.$transaction(async (tx) => {
      const closedShift = await tx.cashRegister.update({
        where: { id: Number(id) },
        data: {
          status: "CLOSED",
          closingTime: new Date(),
          expectedBalance,
          actualBalance: Number(actualBalance),
          discrepancy,
          observations: observations || null,
        },
      });

      const receipt = await createInternalReceipt(tx, {
        receiptType: "CASH_CLOSE",
        branchId: shift.branchId,
        cashRegisterId: shift.id,
        sourceId: shift.id,
        createdBy: authUser.id,
        payload: {
          cashRegisterId: shift.id,
          openedAt: shift.openingTime,
          closedAt: closedShift.closingTime,
          initialBalance: shift.initialBalance,
          expectedBalance,
          actualBalance: Number(actualBalance),
          discrepancy,
          observations: observations || null,
          paymentsCount: shift.payments.length,
          expensesCount: shift.expenses.length,
        },
      });

      return { closedShift, receipt };
    });

    res.status(200).json({
      message: "El turno ha sido cerrado y arqueado correctamente.",
      data: result.closedShift,
      receipt: result.receipt,
    });
  } catch (error: unknown) {
    console.error("Error al cerrar caja:", error);
    res.status(500).json({
      error: "Fallo critico al intentar realizar el cierre contable.",
    });
  }
};

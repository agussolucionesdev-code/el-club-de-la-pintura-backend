import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// ESTADO DE CAJA: Verifica si la sucursal tiene un turno activo operando
// ============================================================================
export const getActiveShift = async (req: Request, res: Response) => {
  try {
    const branchId = Number(req.params.branchId);

    const activeShift = await prisma.cashRegister.findFirst({
      where: {
        branchId: branchId,
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

    const totalIncomes = activeShift.payments.reduce(
      (acc, curr) => acc + curr.amount,
      0,
    );
    const totalExpenses = activeShift.expenses.reduce(
      (acc, curr) => acc + curr.amount,
      0,
    );
    const currentExpectedBalance =
      activeShift.initialBalance + totalIncomes - totalExpenses;

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
      .json({ error: "Fallo de conexión al consultar el cajón de dinero." });
  }
};

// ============================================================================
// APERTURA DE CAJA: Inicia el día laboral con un fondo fijo
// ============================================================================
export const openShift = async (req: Request, res: Response) => {
  try {
    // AHORA RECIBIMOS EL userId DESDE EL FRONTEND
    const { initialBalance, branchId, userId } = req.body;

    const existingOpen = await prisma.cashRegister.findFirst({
      where: { branchId: Number(branchId), status: "OPEN" },
    });

    if (existingOpen) {
      return res.status(400).json({
        error:
          "Atención: Ya existe un turno abierto en esta sucursal. Debe cerrarlo antes de iniciar uno nuevo.",
      });
    }

    // Usamos el ID REAL del usuario que está abriendo la caja
    const newShift = await prisma.cashRegister.create({
      data: {
        initialBalance: Number(initialBalance),
        userId: Number(userId || 1), // <-- ID dinámico inyectado
        branchId: Number(branchId || 1),
        status: "OPEN",
      },
    });

    res.status(201).json({
      message:
        "Caja abierta exitosamente. ¡Que sea una excelente jornada de ventas!",
      data: newShift,
    });
  } catch (error: unknown) {
    console.error("Error crítico al abrir caja:", error);
    res.status(500).json({
      error:
        "Fallo de integridad: Verifique que el Usuario y la Sucursal existan en la base de datos.",
    });
  }
};

// ============================================================================
// CIERRE DE CAJA (ARQUEO): Cierre ciego y cálculo de diferencias
// ============================================================================
export const closeShift = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { actualBalance, observations } = req.body;

    const shift = await prisma.cashRegister.findUnique({
      where: { id: Number(id) },
      include: { payments: true, expenses: true },
    });

    if (!shift || shift.status === "CLOSED") {
      return res.status(400).json({
        error: "El turno indicado no existe o ya fue cerrado previamente.",
      });
    }

    const totalIncomes = shift.payments.reduce(
      (acc, curr) => acc + curr.amount,
      0,
    );
    const totalExpenses = shift.expenses.reduce(
      (acc, curr) => acc + curr.amount,
      0,
    );

    const expectedBalance = shift.initialBalance + totalIncomes - totalExpenses;
    const discrepancy = Number(actualBalance) - expectedBalance;

    const closedShift = await prisma.cashRegister.update({
      where: { id: Number(id) },
      data: {
        status: "CLOSED",
        closingTime: new Date(),
        expectedBalance: expectedBalance,
        actualBalance: Number(actualBalance),
        discrepancy: discrepancy,
        observations: observations || null,
      },
    });

    res.status(200).json({
      message: "El turno ha sido cerrado y arqueado correctamente.",
      data: closedShift,
    });
  } catch (error: unknown) {
    console.error("Error al cerrar caja:", error);
    res.status(500).json({
      error: "Fallo crítico al intentar realizar el cierre contable.",
    });
  }
};

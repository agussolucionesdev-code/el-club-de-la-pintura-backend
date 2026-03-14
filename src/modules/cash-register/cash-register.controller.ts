import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// OPEN SHIFT: Apertura de Turno y Fondo de Caja
// ============================================================================
export const openShift = async (req: Request, res: Response) => {
  try {
    const { branchId, initialBalance } = req.body;
    const authUser = (req as any).user;

    if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
      return res.status(403).json({
        error: "Brecha de seguridad: No tienes acceso a esta sucursal.",
      });
    }

    const existingOpenShift = await prisma.cashRegister.findFirst({
      where: {
        userId: authUser.id,
        branchId: branchId,
        status: "OPEN",
      },
    });

    if (existingOpenShift) {
      return res.status(400).json({
        error:
          "Conflicto Operativo: Ya tienes un turno de caja abierto en esta sucursal.",
        activeShiftId: existingOpenShift.id,
      });
    }

    const newShift = await prisma.cashRegister.create({
      data: {
        initialBalance: Number(initialBalance),
        userId: authUser.id,
        branchId: branchId,
        status: "OPEN",
      },
    });

    res.status(201).json({
      message: "Turno de caja abierto exitosamente.",
      shift: newShift,
    });
  } catch (error) {
    console.error("Error al abrir la caja:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al inicializar el turno de caja." });
  }
};

// ============================================================================
// GET SHIFT STATUS: Arqueo Dinámico (Ventas, Pagos y Descuento de Gastos)
// ============================================================================
export const getActiveShiftStatus = async (req: Request, res: Response) => {
  try {
    const { branchId } = req.params;
    const authUser = (req as any).user;

    const activeShift = await prisma.cashRegister.findFirst({
      where: {
        userId: authUser.id,
        branchId: Number(branchId),
        status: "OPEN",
      },
      include: {
        payments: true,
        sales: true,
        expenses: true, // INYECCIÓN: Traemos los retiros de caja
      },
    });

    if (!activeShift) {
      return res
        .status(404)
        .json({ error: "No tienes ningún turno abierto en esta sucursal." });
    }

    // 1. Desglose de Pagos por Método
    const paymentBreakdown: Record<string, number> = {};
    let totalCashCollected = 0;
    let totalDigitalCollected = 0;

    activeShift.payments.forEach((payment) => {
      const method = payment.paymentMethod.toUpperCase();
      if (!paymentBreakdown[method]) paymentBreakdown[method] = 0;
      paymentBreakdown[method] += payment.amount;

      if (method === "EFECTIVO" || method === "CASH") {
        totalCashCollected += payment.amount;
      } else {
        totalDigitalCollected += payment.amount;
      }
    });

    // 2. Cálculo de la Deuda Generada
    const totalDebtGenerated = activeShift.sales.reduce(
      (sum, sale) => sum + sale.balance,
      0,
    );
    const totalBilled = activeShift.sales.reduce(
      (sum, sale) => sum + sale.totalAmount,
      0,
    );

    // 3. INYECCIÓN: Cálculo de Gastos Operativos
    const totalExpensesAmount = activeShift.expenses.reduce(
      (sum, expense) => sum + expense.amount,
      0,
    );

    // 4. Plata física que TIENE que haber en el cajón de madera (Fondo + Ventas Efectivo - Gastos)
    const expectedCashInDrawer =
      activeShift.initialBalance + totalCashCollected - totalExpensesAmount;

    res.status(200).json({
      message: "Arqueo de caja dinámico calculado con éxito.",
      shiftDetails: {
        shiftId: activeShift.id,
        openingTime: activeShift.openingTime,
        initialBalance: activeShift.initialBalance,
      },
      billingSummary: {
        totalBilled,
        totalDebtGenerated,
      },
      collectionsBreakdown: {
        totalCollected: totalCashCollected + totalDigitalCollected,
        methods: paymentBreakdown,
      },
      expenseAudit: {
        totalExpenses: totalExpensesAmount,
        expenseCount: activeShift.expenses.length,
      },
      cashAudit: {
        expectedCashInDrawer,
      },
    });
  } catch (error) {
    console.error("Error al consultar estado de caja:", error);
    res
      .status(500)
      .json({ error: "Fallo al calcular el arqueo de caja actual." });
  }
};

// ============================================================================
// CLOSE SHIFT: Cierre de Turno y Auditoría Exacta con Gastos
// ============================================================================
export const closeShift = async (req: Request, res: Response) => {
  try {
    const { branchId } = req.params;
    const { actualBalance, observations } = req.body;
    const authUser = (req as any).user;

    const result = await prisma.$transaction(async (tx) => {
      const activeShift = await tx.cashRegister.findFirst({
        where: {
          userId: authUser.id,
          branchId: Number(branchId),
          status: "OPEN",
        },
        include: { payments: true, sales: true, expenses: true }, // INYECCIÓN
      });

      if (!activeShift) {
        throw new Error("No se encontró un turno abierto para cerrar.");
      }

      let totalCashCollected = 0;
      const paymentBreakdown: Record<string, number> = {};

      activeShift.payments.forEach((p) => {
        const method = p.paymentMethod.toUpperCase();
        if (!paymentBreakdown[method]) paymentBreakdown[method] = 0;
        paymentBreakdown[method] += p.amount;

        if (method === "EFECTIVO" || method === "CASH") {
          totalCashCollected += p.amount;
        }
      });

      // INYECCIÓN: Restamos los gastos para que el cierre sea exacto
      const totalExpensesAmount = activeShift.expenses.reduce(
        (sum, exp) => sum + exp.amount,
        0,
      );

      const expectedBalance =
        activeShift.initialBalance + totalCashCollected - totalExpensesAmount;
      const discrepancy = Number(actualBalance) - expectedBalance;

      const autoNotes = `Desglose Digital: ${JSON.stringify(paymentBreakdown)}. Deuda generada: $${activeShift.sales.reduce((s, a) => s + a.balance, 0)}. Gastos Operativos: $${totalExpensesAmount}. `;
      const finalObservations = observations
        ? `${autoNotes} | Notas Empleado: ${observations}`
        : autoNotes;

      const closedShift = await tx.cashRegister.update({
        where: { id: activeShift.id },
        data: {
          status: "CLOSED",
          closingTime: new Date(),
          expectedBalance,
          actualBalance: Number(actualBalance),
          discrepancy,
          observations: finalObservations,
        },
      });

      return { closedShift, paymentBreakdown, totalExpensesAmount };
    });

    const finalDiscrepancy = result.closedShift.discrepancy || 0;

    res.status(200).json({
      message: "Turno cerrado y caja auditada con éxito.",
      auditResult: {
        expectedCash: result.closedShift.expectedBalance,
        countedCash: result.closedShift.actualBalance,
        totalExpensesDeducted: result.totalExpensesAmount, // Se lo mostramos como comprobante
        discrepancy: finalDiscrepancy,
        status:
          finalDiscrepancy === 0
            ? "CAJA PERFECTA"
            : finalDiscrepancy < 0
              ? "FALTANTE"
              : "SOBRANTE",
      },
      digitalBreakdown: result.paymentBreakdown,
      shift: result.closedShift,
    });
  } catch (error: any) {
    console.error("Error crítico al cerrar la caja:", error);
    if (error instanceof Error) {
      return res.status(400).json({ error: error.message });
    }
    res
      .status(500)
      .json({ error: "Fallo estructural en el proceso de cierre de caja." });
  }
};

/**
 * Terminal de prueba para una sucursal.
 *
 * Desde el paso de CONTRACT de la Fase 3, `CashRegister.terminalId` es NOT NULL:
 * un turno sin terminal es un arqueo sin cajón. Los fixtures que abren caja
 * necesitan una terminal, y este helper la crea (o reusa la que ya haya) sin que
 * cada test tenga que ocuparse.
 *
 * Idempotente por sucursal: llamarlo dos veces devuelve la misma terminal.
 */

import prisma from "../../src/config/db";

export const testTerminalFor = async (branchId: number): Promise<number> => {
  const existente = await prisma.terminal.findFirst({
    where: { branchId },
    select: { id: true },
  });
  if (existente) return existente.id;

  const creada = await prisma.terminal.create({
    data: {
      code: `TEST-${branchId}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      name: "Caja de pruebas",
      branchId,
    },
    select: { id: true },
  });
  return creada.id;
};

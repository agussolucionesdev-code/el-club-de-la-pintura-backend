/**
 * Movimientos de efectivo del cajón: el contrato, en un solo lugar.
 *
 * ── Por qué este archivo existe ─────────────────────────────────────────────
 *
 * `CashMovement.type` era un `String` suelto con el contrato escrito en un
 * comentario del esquema: `"IN"` o `"OUT"`. El módulo de caja escribía y leía
 * esos dos valores, y todo cerraba.
 *
 * Hasta que el libro del personal —otro módulo, otro archivo— escribió
 * `"INCOME"` para registrar el cobro en efectivo de una cuenta de empleado.
 * Es un valor perfectamente razonable si uno no leyó el comentario del esquema,
 * y la base lo aceptó sin chistar porque es un `String`.
 *
 * El resultado: la plata entraba al cajón de verdad, pero el arqueo no la
 * contaba. **El turno cerraba con un sobrante inexplicable**, exactamente igual
 * a lo que los empleados hubieran pagado en efectivo.
 *
 * ── El defecto de fondo NO era el typo ──────────────────────────────────────
 *
 * Era que la suma **descartaba en silencio** todo lo que no reconocía:
 *
 *     const totalCashIn  = movs.reduce((a, m) => m.type === "IN"  ? a + m.amount : a, 0);
 *     const totalCashOut = movs.reduce((a, m) => m.type === "OUT" ? a + m.amount : a, 0);
 *
 * Un movimiento con el tipo mal escrito no rompía nada: desaparecía. Y una
 * diferencia de caja sin causa visible es de las cosas más caras de diagnosticar
 * en un negocio, porque la sospecha cae sobre las personas antes que sobre el
 * software.
 *
 * Así que acá el contrato es explícito, y lo que no se reconoce **se informa**.
 */

import { logger } from "../config/logger";

export const CASH_IN = "IN" as const;
export const CASH_OUT = "OUT" as const;

export type CashMovementType = typeof CASH_IN | typeof CASH_OUT;

export const CASH_MOVEMENT_TYPES: readonly string[] = [CASH_IN, CASH_OUT];

export const isCashMovementType = (value: string): value is CashMovementType =>
  value === CASH_IN || value === CASH_OUT;

export type CashMovementLike = { amount: number; type: string };

export type CashMovementTotals = {
  totalIn: number;
  totalOut: number;
  /**
   * Movimientos cuyo tipo no se reconoce.
   *
   * No se descartan callados: van al log y suben hasta la pantalla de cierre,
   * para que una diferencia de caja tenga una causa visible en vez de quedar
   * como un misterio que alguien va a terminar atribuyendo a un error humano.
   */
  unclassified: { count: number; total: number; types: string[] };
};

export const sumCashMovements = (
  movements: readonly CashMovementLike[],
): CashMovementTotals => {
  let totalIn = 0;
  let totalOut = 0;
  let unclassifiedCount = 0;
  let unclassifiedTotal = 0;
  const tiposRaros = new Set<string>();

  for (const movimiento of movements) {
    if (movimiento.type === CASH_IN) {
      totalIn += movimiento.amount;
    } else if (movimiento.type === CASH_OUT) {
      totalOut += movimiento.amount;
    } else {
      unclassifiedCount += 1;
      unclassifiedTotal += movimiento.amount;
      tiposRaros.add(movimiento.type);
    }
  }

  if (unclassifiedCount > 0) {
    logger.error(
      `[caja] ${unclassifiedCount} movimiento(s) de efectivo con tipo desconocido ` +
        `(${[...tiposRaros].join(", ")}) por $${unclassifiedTotal}. ` +
        `No entran en el efectivo esperado y el arqueo va a dar diferencia.`,
    );
  }

  return {
    totalIn,
    totalOut,
    unclassified: {
      count: unclassifiedCount,
      total: unclassifiedTotal,
      types: [...tiposRaros],
    },
  };
};

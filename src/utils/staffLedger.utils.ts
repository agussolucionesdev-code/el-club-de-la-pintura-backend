/**
 * El libro del personal: saldos, traslados y qué pasa cuando algo se devuelve.
 *
 * ── Por qué esto vive en funciones puras ────────────────────────────────────
 *
 * Acá se decide cuánta plata le debe una persona a su empleador. Esa aritmética
 * tiene que ser verificable sin levantar una base ni un servidor, y tiene que
 * poder probarse contra secuencias generadas de devoluciones parciales — que es
 * donde aparecen los saldos negativos que nadie ve venir.
 *
 * Todo con `Prisma.Decimal`: un centavo perdido por punto flotante en un saldo
 * que se descuenta del sueldo es una discusión con una persona, no un bug.
 */

import { Prisma } from "@prisma/client";

const D = (v: Prisma.Decimal.Value): Prisma.Decimal => new Prisma.Decimal(v);
export const ZERO = D(0);

export class LedgerInvariantError extends Error {
  readonly code = "LEDGER_INVARIANT_VIOLATED";
  constructor(message: string) {
    super(message);
    this.name = "LedgerInvariantError";
  }
}

// ── Saldo ──────────────────────────────────────────────────────────────────

export type LedgerEntry = {
  debit: Prisma.Decimal.Value;
  credit: Prisma.Decimal.Value;
};

/**
 * Saldo = débitos − créditos. Positivo = debe.
 *
 * Se recorre el libro entero en vez de guardar un saldo denormalizado. Con el
 * volumen de esta pinturería —unas decenas de asientos por persona— el costo es
 * irrelevante, y a cambio el saldo NO PUEDE desincronizarse de sus asientos.
 * Un total guardado aparte es un segundo lugar donde la verdad puede estar mal.
 */
export const computeStaffBalance = (entries: LedgerEntry[]): Prisma.Decimal =>
  entries.reduce(
    (saldo, e) => saldo.plus(D(e.debit)).minus(D(e.credit)),
    ZERO,
  );

// ── Traslado activo de una venta ───────────────────────────────────────────

export type TransferableSale = {
  balance: Prisma.Decimal.Value;
  transferredToStaffLedger: Prisma.Decimal.Value;
  transferReversed: Prisma.Decimal.Value;
};

/** Lo trasladado que sigue vigente: acumulado menos lo revertido. */
export const activeTransferred = (sale: TransferableSale): Prisma.Decimal =>
  D(sale.transferredToStaffLedger).minus(D(sale.transferReversed));

/**
 * Cuánto de esta venta sigue siendo cuenta corriente del cliente.
 *
 * `status` y `balance` NO se tocan al trasladar: siguen diciendo lo que la
 * venta fue. La deuda vigente es lo que queda **fuera** de lo trasladado.
 *
 * El `max(..., 0)` es la red de seguridad, no la lógica: `planReturnAllocation`
 * garantiza que nunca haga falta. Si alguna vez este máximo llegara a actuar,
 * significaría que algo escribió un traslado mayor al saldo — y eso es un bug
 * que hay que encontrar, no redondear.
 */
export const activeReceivable = (sale: TransferableSale): Prisma.Decimal => {
  const vigente = D(sale.balance).minus(activeTransferred(sale));
  return vigente.isNegative() ? ZERO : vigente;
};

// ── Devoluciones sobre mercadería ya trasladada ────────────────────────────

export type ReturnAllocation = {
  /** Se acredita en el LIBRO DEL PERSONAL: ahí es donde vive esa deuda ahora. */
  toStaffLedger: Prisma.Decimal;
  /** Se trata como devolución normal contra la cuenta corriente del cliente. */
  toCustomerAccount: Prisma.Decimal;
};

/**
 * Cómo se reparte una devolución entre lo trasladado y lo no trasladado.
 *
 * ── El problema que resuelve ────────────────────────────────────────────────
 *
 * Si una venta trasladada recibe después una devolución, `balance` baja pero el
 * monto trasladado quedaba fijo. Resultado: `balance - trasladado < 0`, o sea
 * una cuenta por cobrar NEGATIVA. Contablemente absurdo, y además significaría
 * que el sistema cree que el cliente tiene saldo a favor por mercadería que en
 * realidad se le cargó a un empleado.
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 *
 * La devolución reduce **primero la porción trasladada**, que es donde vive la
 * deuda ahora, y sólo el excedente toca la porción del cliente. Es lo correcto
 * y además lo intuitivo: si la mercadería se le había cargado al empleado,
 * devolverla lo tiene que descargar a él.
 */
export const planReturnAllocation = (
  sale: TransferableSale,
  refundAmount: Prisma.Decimal.Value,
): ReturnAllocation => {
  const monto = D(refundAmount);

  if (monto.isNegative()) {
    throw new LedgerInvariantError(
      "El monto de una devolución no puede ser negativo.",
    );
  }

  const trasladadoVivo = activeTransferred(sale);
  const alTrasladado = Prisma.Decimal.min(monto, trasladadoVivo);

  return {
    toStaffLedger: alTrasladado,
    toCustomerAccount: monto.minus(alTrasladado),
  };
};

// ── Ciclos de traslado ─────────────────────────────────────────────────────

export type TransferCycle = {
  transferredAmount: Prisma.Decimal.Value;
  reversedAmount: Prisma.Decimal.Value;
};

export type CycleStatus = "ACTIVE" | "PARTIALLY_REVERSED" | "FULLY_REVERSED";

/**
 * En qué estado queda un ciclo después de revertirle un monto.
 *
 * El estado no se elige a mano: se DERIVA de los montos. Dejarlo a criterio de
 * quien escribe el código abre la puerta a un ciclo marcado ACTIVE con todo
 * revertido —que seguiría ocupando el índice de ciclo vivo y bloquearía el
 * re-traslado para siempre.
 */
export const resolveCycleStatus = (cycle: TransferCycle): CycleStatus => {
  const trasladado = D(cycle.transferredAmount);
  const revertido = D(cycle.reversedAmount);

  if (revertido.greaterThan(trasladado)) {
    throw new LedgerInvariantError(
      `Se revirtieron ${revertido.toFixed(2)} de un ciclo que sólo trasladó ` +
        `${trasladado.toFixed(2)}. Eso le devolvería a alguien plata que nunca se le cargó.`,
    );
  }

  if (revertido.isZero()) return "ACTIVE";
  return revertido.equals(trasladado) ? "FULLY_REVERSED" : "PARTIALLY_REVERSED";
};

/** ¿Este ciclo sigue ocupando el índice de "un solo ciclo vivo por venta"? */
export const isLiveCycle = (status: CycleStatus): boolean =>
  status === "ACTIVE" || status === "PARTIALLY_REVERSED";

// ── Invariantes ────────────────────────────────────────────────────────────

/**
 * Se verifica DENTRO de la transacción, antes de committear.
 *
 * No es defensa contra un atacante: es defensa contra nosotros mismos. Una
 * aritmética de saldos mal hecha no explota — sigue andando y devolviendo
 * números creíbles hasta que alguien reclama que le descontaron de más. Si algo
 * de esto no cierra, la transacción entera se revierte.
 */
export const assertTransferInvariants = (
  sale: TransferableSale,
  cycles: TransferCycle[],
): void => {
  for (const [i, ciclo] of cycles.entries()) {
    if (D(ciclo.reversedAmount).greaterThan(D(ciclo.transferredAmount))) {
      throw new LedgerInvariantError(
        `El ciclo ${i + 1} tiene más revertido que trasladado.`,
      );
    }
  }

  const vivos = cycles.filter((c) => isLiveCycle(resolveCycleStatus(c)));
  if (vivos.length > 1) {
    throw new LedgerInvariantError(
      `Hay ${vivos.length} ciclos vivos sobre la misma venta. Debe haber a lo sumo uno: ` +
        "dos traslados activos duplicarían la deuda de una persona.",
    );
  }

  const trasladado = D(sale.transferredToStaffLedger);
  const revertido = D(sale.transferReversed);

  if (revertido.greaterThan(trasladado)) {
    throw new LedgerInvariantError(
      "La venta tiene más revertido que trasladado.",
    );
  }

  const sumaCiclos = cycles.reduce((s, c) => s.plus(D(c.transferredAmount)), ZERO);
  if (!sumaCiclos.equals(trasladado)) {
    throw new LedgerInvariantError(
      `Los acumulados de la venta (${trasladado.toFixed(2)}) no cierran con la suma ` +
        `de sus ciclos (${sumaCiclos.toFixed(2)}).`,
    );
  }

  if (activeTransferred(sale).greaterThan(D(sale.balance))) {
    throw new LedgerInvariantError(
      `Se trasladaron ${activeTransferred(sale).toFixed(2)} de una venta cuyo saldo es ` +
        `${D(sale.balance).toFixed(2)}. No se puede trasladar más deuda de la que existe.`,
    );
  }
};

// ── Política de precio del consumo interno ─────────────────────────────────

export type PricePolicy = "RETAIL" | "COST" | "COST_PLUS" | "STAFF_DISCOUNT" | "EXPLICIT";

/**
 * A qué precio se le carga la mercadería a un empleado.
 *
 * El resultado y la política se congelan en la operación. Sin eso, "¿por qué
 * este pincel se le cargó a $3.000 y aquél a $4.200?" no tiene respuesta seis
 * meses después, y el origen del precio queda implícito — que es justo lo que
 * genera desconfianza cuando se trata del sueldo de alguien.
 */
export const resolveInternalPrice = ({
  policy,
  rate,
  listPrice,
  costPrice,
  explicitPrice,
}: {
  policy: PricePolicy;
  rate?: Prisma.Decimal.Value | null;
  listPrice: Prisma.Decimal.Value;
  costPrice?: Prisma.Decimal.Value | null;
  explicitPrice?: Prisma.Decimal.Value | null;
}): Prisma.Decimal => {
  const lista = D(listPrice);
  const porcentaje = rate == null ? ZERO : D(rate);

  const exigirCosto = (): Prisma.Decimal => {
    if (costPrice == null) {
      // Un costo desconocido NO es cero (regla de la Fase 2). Cargarle $0 a un
      // empleado por un producto sin costo cargado sería regalarle mercadería
      // por un vacío de datos.
      throw new LedgerInvariantError(
        "Este producto no tiene costo cargado, así que no se puede aplicar una " +
          "política basada en el costo. Cargá el costo o elegí precio de lista.",
      );
    }
    return D(costPrice);
  };

  switch (policy) {
    case "RETAIL":
      return lista;
    case "COST":
      return exigirCosto();
    case "COST_PLUS":
      return exigirCosto().times(D(100).plus(porcentaje)).dividedBy(100);
    case "STAFF_DISCOUNT":
      return lista.times(D(100).minus(porcentaje)).dividedBy(100);
    case "EXPLICIT":
      if (explicitPrice == null) {
        throw new LedgerInvariantError(
          "Un precio excepcional exige que se indique cuál es.",
        );
      }
      return D(explicitPrice);
  }
};

/**
 * Motor de incentivos: aritmética pura, sin base de datos.
 *
 * Todo lo que decide plata vive acá y se testea sin levantar Postgres. Los
 * controladores orquestan; este archivo calcula.
 *
 * ── Semántica de los estados del asiento ────────────────────────────────────
 *
 * `ELIGIBLE`    — plata. Es lo ÚNICO que suma en una liquidación. Puede ser
 *                 negativo: así se registran las reversiones por devolución o
 *                 anulación, sin editar jamás el asiento original.
 * `PROVISIONAL` — pronóstico, NO plata. Existe para que el vendedor vea "tenés
 *                 tanto en camino, se libera cuando el cliente pague". Nunca
 *                 entra en una liquidación.
 * `REVERSED`    — un PROVISIONAL que ya no corresponde: la venta se anuló, o se
 *                 cobró por completo y su comisión ya vive en asientos
 *                 ELIGIBLE. Marca de cierre, no un monto.
 *
 * Consecuencia de diseño: el remanente provisional de una venta **se deriva**
 * (`base provisional original − lo ya vuelto elegible`), no se guarda mutando
 * la fila. Un asiento nunca cambia de monto; el pasado no se reescribe.
 */
import { Prisma } from "@prisma/client";

export const D = (value: Prisma.Decimal.Value): Prisma.Decimal =>
  new Prisma.Decimal(value);

export const ZERO = D(0);

export class IncentiveInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncentiveInvariantError";
  }
}

// ══════════════════════════════════════════════════════════════════════════
// Períodos
// ══════════════════════════════════════════════════════════════════════════

export type Cadence = "WEEKLY" | "BIWEEKLY" | "MONTHLY";

/**
 * Argentina no aplica horario de verano desde 2009: es UTC−3 todo el año.
 *
 * Se fija el desplazamiento en vez de depender de la zona del proceso porque
 * Render corre en UTC. Sin esto, una venta de las 22:00 del 31 de agosto caería
 * en septiembre y le pagaría la comisión al mes equivocado.
 */
const AR_OFFSET_MINUTES = -180;

const toArgentina = (instant: Date): Date =>
  new Date(instant.getTime() + AR_OFFSET_MINUTES * 60_000);

const fromArgentina = (wallClock: Date): Date =>
  new Date(wallClock.getTime() - AR_OFFSET_MINUTES * 60_000);

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/** Lunes de la semana ISO que contiene `wallClock` (hora de pared argentina). */
const isoWeekStart = (wallClock: Date): Date => {
  const base = new Date(
    Date.UTC(
      wallClock.getUTCFullYear(),
      wallClock.getUTCMonth(),
      wallClock.getUTCDate(),
    ),
  );
  // getUTCDay(): 0 = domingo. ISO cuenta el lunes como día 1.
  const offset = (base.getUTCDay() + 6) % 7;
  base.setUTCDate(base.getUTCDate() - offset);
  return base;
};

/** Número de semana ISO 8601 y su año (que puede no ser el del calendario). */
const isoWeek = (wallClock: Date): { year: number; week: number } => {
  const monday = isoWeekStart(wallClock);
  const thursday = new Date(monday);
  thursday.setUTCDate(thursday.getUTCDate() + 3); // el jueves define el año ISO
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const firstMonday = isoWeekStart(firstThursday);
  const week =
    Math.round(
      (monday.getTime() - firstMonday.getTime()) / (7 * 24 * 3600 * 1000),
    ) + 1;
  return { year, week };
};

/**
 * Clave legible del período que contiene ese instante.
 *
 * Es lo que alguien dice en voz alta: "la liquidación de 2026-08".
 */
export const resolvePeriodKey = (instant: Date, cadence: Cadence): string => {
  const wall = toArgentina(instant);
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth() + 1;

  if (cadence === "MONTHLY") return `${year}-${pad(month)}`;

  if (cadence === "BIWEEKLY") {
    const quincena = wall.getUTCDate() <= 15 ? 1 : 2;
    return `${year}-${pad(month)}-Q${quincena}`;
  }

  const { year: isoYear, week } = isoWeek(wall);
  return `${isoYear}-W${pad(week)}`;
};

/**
 * Límites del período, en instantes UTC listos para una query.
 *
 * `endsAt` es EXCLUSIVO: el instante en que arranca el período siguiente. Un
 * fin inclusivo obliga a elegir entre 23:59:59.999 y perder los milisegundos
 * de después — una venta a las 23:59:59.9995 quedaría fuera de todo período.
 */
export const periodBounds = (
  key: string,
  cadence: Cadence,
): { startsAt: Date; endsAt: Date } => {
  if (cadence === "MONTHLY") {
    const match = /^(\d{4})-(\d{2})$/u.exec(key);
    if (!match) throw new IncentiveInvariantError(`Clave mensual inválida: "${key}".`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    return {
      startsAt: fromArgentina(new Date(Date.UTC(year, month - 1, 1))),
      endsAt: fromArgentina(new Date(Date.UTC(year, month, 1))),
    };
  }

  if (cadence === "BIWEEKLY") {
    const match = /^(\d{4})-(\d{2})-Q([12])$/u.exec(key);
    if (!match) throw new IncentiveInvariantError(`Clave quincenal inválida: "${key}".`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const quincena = Number(match[3]);
    return quincena === 1
      ? {
          startsAt: fromArgentina(new Date(Date.UTC(year, month - 1, 1))),
          endsAt: fromArgentina(new Date(Date.UTC(year, month - 1, 16))),
        }
      : {
          startsAt: fromArgentina(new Date(Date.UTC(year, month - 1, 16))),
          endsAt: fromArgentina(new Date(Date.UTC(year, month, 1))),
        };
  }

  const match = /^(\d{4})-W(\d{2})$/u.exec(key);
  if (!match) throw new IncentiveInvariantError(`Clave semanal inválida: "${key}".`);
  const isoYear = Number(match[1]);
  const week = Number(match[2]);
  const firstMonday = isoWeekStart(new Date(Date.UTC(isoYear, 0, 4)));
  const startWall = new Date(firstMonday);
  startWall.setUTCDate(startWall.getUTCDate() + (week - 1) * 7);
  const endWall = new Date(startWall);
  endWall.setUTCDate(endWall.getUTCDate() + 7);
  return {
    startsAt: fromArgentina(startWall),
    endsAt: fromArgentina(endWall),
  };
};

// ══════════════════════════════════════════════════════════════════════════
// Elegibilidad: la decisión que el negocio todavía no cerró
// ══════════════════════════════════════════════════════════════════════════

export type EligibilityPolicy = "ON_SALE" | "ON_COLLECTION" | "MIXED";

export type SaleBasis = {
  /** Base comisionable total de la venta, ya neta de devoluciones previas. */
  totalBase: Prisma.Decimal.Value;
  /** Lo que entró al instante: efectivo, tarjeta, transferencia. */
  collectedNow: Prisma.Decimal.Value;
};

export type EligibilitySplit = {
  /** Base que se gana ya. Genera asiento ELIGIBLE. */
  eligibleBase: Prisma.Decimal;
  /** Base a la espera del cobro. Genera asiento PROVISIONAL, que no es plata. */
  provisionalBase: Prisma.Decimal;
};

/**
 * Parte la base de una venta entre lo que se gana ya y lo que espera al cobro.
 *
 * Las tres políticas son la misma máquina con un interruptor distinto:
 *
 * - `ON_SALE`       → todo elegible. El vendedor cobra aunque el fiado nunca
 *                     se cobre. Es el riesgo que asume el negocio.
 * - `ON_COLLECTION` → nada elegible al vender. Todo espera la plata.
 * - `MIXED`         → lo cobrado al instante es elegible; la cuenta corriente
 *                     queda provisional. El default, y el único que no paga
 *                     comisión sobre plata que no entró.
 */
export const splitEligibility = (
  policy: EligibilityPolicy,
  basis: SaleBasis,
): EligibilitySplit => {
  const total = D(basis.totalBase);
  const cobrado = D(basis.collectedNow);

  if (total.isNegative()) {
    throw new IncentiveInvariantError(
      `La base comisionable no puede ser negativa (${total.toString()}).`,
    );
  }
  if (cobrado.isNegative()) {
    throw new IncentiveInvariantError(
      `Lo cobrado no puede ser negativo (${cobrado.toString()}).`,
    );
  }

  if (policy === "ON_SALE") {
    return { eligibleBase: total, provisionalBase: ZERO };
  }
  if (policy === "ON_COLLECTION") {
    return { eligibleBase: ZERO, provisionalBase: total };
  }

  // MIXED. Se acota contra el total porque un cobro puede superar la base
  // comisionable: la venta pudo tener una devolución parcial previa que bajó la
  // base sin devolver la plata todavía.
  const elegible = Prisma.Decimal.min(cobrado, total);
  return { eligibleBase: elegible, provisionalBase: total.minus(elegible) };
};

/**
 * Cuánta base provisional queda viva en una venta.
 *
 * Se DERIVA en vez de guardarse: los asientos son inmutables, así que el
 * remanente es la base provisional original menos lo que ya se volvió elegible
 * por cobros posteriores. Nunca negativo.
 */
export const outstandingProvisional = (
  provisionalBase: Prisma.Decimal.Value,
  convertedBase: Prisma.Decimal.Value,
): Prisma.Decimal => {
  const restante = D(provisionalBase).minus(D(convertedBase));
  return restante.isNegative() ? ZERO : restante;
};

// ══════════════════════════════════════════════════════════════════════════
// Cálculo del monto
// ══════════════════════════════════════════════════════════════════════════

export type RuleKind = "PERCENT_OF_SALES" | "TIERED_PERCENT" | "FIXED_ON_TARGET";

export type Rule = {
  id: number;
  kind: RuleKind;
  percent: Prisma.Decimal.Value | null;
  fromAmount: Prisma.Decimal.Value | null;
  toAmount: Prisma.Decimal.Value | null;
  fixedAmount: Prisma.Decimal.Value | null;
  targetAmount: Prisma.Decimal.Value | null;
};

export type CommissionResult = {
  amount: Prisma.Decimal;
  /** La regla exacta que se aplicó, para congelar en el asiento. */
  snapshot: Record<string, unknown>;
};

const asNumberOrNull = (value: Prisma.Decimal.Value | null): string | null =>
  value === null ? null : D(value).toString();

const snapshotOf = (rule: Rule, extra: Record<string, unknown> = {}) => ({
  ruleId: rule.id,
  kind: rule.kind,
  percent: asNumberOrNull(rule.percent),
  fromAmount: asNumberOrNull(rule.fromAmount),
  toAmount: asNumberOrNull(rule.toAmount),
  fixedAmount: asNumberOrNull(rule.fixedAmount),
  targetAmount: asNumberOrNull(rule.targetAmount),
  ...extra,
});

const requirePercent = (rule: Rule): Prisma.Decimal => {
  if (rule.percent === null) {
    throw new IncentiveInvariantError(
      `La regla ${rule.id} (${rule.kind}) no tiene porcentaje cargado.`,
    );
  }
  return D(rule.percent);
};

/** Redondeo a 2 decimales, medio arriba. Es lo que se paga en un recibo. */
const money = (value: Prisma.Decimal): Prisma.Decimal =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/**
 * Cuánta comisión genera una base, según las reglas vigentes del plan.
 *
 * `periodBase` es lo acumulado por esa persona en el período ANTES de esta
 * base. Los escalones y las metas se miden sobre el acumulado, no sobre la
 * venta suelta: si no, vender $100.000 en una sola operación pagaría distinto
 * que venderlos en diez, y eso invita a inflar tickets.
 */
export const computeCommission = (
  rules: Rule[],
  base: Prisma.Decimal.Value,
  periodBase: Prisma.Decimal.Value = 0,
): CommissionResult => {
  const monto = D(base);
  if (monto.isNegative()) {
    throw new IncentiveInvariantError(
      `La base no puede ser negativa (${monto.toString()}).`,
    );
  }
  if (rules.length === 0) {
    throw new IncentiveInvariantError("El plan no tiene reglas vigentes.");
  }

  const acumuladoPrevio = D(periodBase);

  const plana = rules.find((r) => r.kind === "PERCENT_OF_SALES");
  if (plana) {
    const pct = requirePercent(plana);
    return {
      amount: money(monto.times(pct).dividedBy(100)),
      snapshot: snapshotOf(plana, { base: monto.toString() }),
    };
  }

  const escalones = rules.filter((r) => r.kind === "TIERED_PERCENT");
  if (escalones.length > 0) {
    return computeTiered(escalones, monto, acumuladoPrevio);
  }

  const fija = rules.find((r) => r.kind === "FIXED_ON_TARGET");
  if (fija) {
    if (fija.fixedAmount === null || fija.targetAmount === null) {
      throw new IncentiveInvariantError(
        `La regla ${fija.id} (FIXED_ON_TARGET) necesita monto y meta.`,
      );
    }
    const meta = D(fija.targetAmount);
    const antes = acumuladoPrevio;
    const despues = antes.plus(monto);
    // El premio se paga UNA vez: en la operación que cruza la meta.
    const cruza = antes.lessThan(meta) && despues.greaterThanOrEqualTo(meta);
    return {
      amount: cruza ? money(D(fija.fixedAmount)) : ZERO,
      snapshot: snapshotOf(fija, {
        base: monto.toString(),
        acumuladoPrevio: antes.toString(),
        cruzaLaMeta: cruza,
      }),
    };
  }

  throw new IncentiveInvariantError("Ninguna regla del plan es aplicable.");
};

/**
 * Escalones: cada tramo del acumulado paga su propio porcentaje.
 *
 * Marginal, no total. Si el escalón 2 arranca en $500.000 al 4% y la persona
 * lleva $480.000, una venta de $40.000 paga 3% sobre $20.000 y 4% sobre los
 * otros $20.000 — no 4% sobre los $40.000 enteros. Lo contrario genera un salto
 * donde vender un peso más paga varios miles más, y eso se manipula.
 */
const computeTiered = (
  escalones: Rule[],
  base: Prisma.Decimal,
  acumuladoPrevio: Prisma.Decimal,
): CommissionResult => {
  const ordenados = [...escalones].sort((a, b) =>
    D(a.fromAmount ?? 0).comparedTo(D(b.fromAmount ?? 0)),
  );

  let total = ZERO;
  const tramos: Record<string, unknown>[] = [];
  const desde = acumuladoPrevio;
  const hasta = acumuladoPrevio.plus(base);

  for (const escalon of ordenados) {
    const pct = requirePercent(escalon);
    const inicio = D(escalon.fromAmount ?? 0);
    const fin = escalon.toAmount === null ? null : D(escalon.toAmount);

    const solapeInicio = Prisma.Decimal.max(desde, inicio);
    const solapeFin = fin === null ? hasta : Prisma.Decimal.min(hasta, fin);
    if (solapeFin.lessThanOrEqualTo(solapeInicio)) continue;

    const porcionBase = solapeFin.minus(solapeInicio);
    const porcion = porcionBase.times(pct).dividedBy(100);
    total = total.plus(porcion);
    tramos.push({
      ruleId: escalon.id,
      percent: pct.toString(),
      baseDelTramo: porcionBase.toString(),
      comision: money(porcion).toString(),
    });
  }

  return {
    amount: money(total),
    snapshot: {
      kind: "TIERED_PERCENT",
      base: base.toString(),
      acumuladoPrevio: acumuladoPrevio.toString(),
      tramos,
    },
  };
};

// ══════════════════════════════════════════════════════════════════════════
// Margen mínimo
// ══════════════════════════════════════════════════════════════════════════

export type MarginInput = {
  /** Precio cobrado por la línea. */
  revenue: Prisma.Decimal.Value;
  /** Costo congelado. `null` = DESCONOCIDO, que no es cero. */
  cost: Prisma.Decimal.Value | null;
};

export type MarginVerdict =
  | { computable: true; marginPct: Prisma.Decimal; passes: boolean }
  | { computable: false };

/**
 * Evalúa una operación contra el margen mínimo del plan.
 *
 * Una operación con costo desconocido devuelve `computable: false`: no computa
 * para la regla y se reporta aparte con su monto. Asumir margen cero la
 * excluiría en silencio; asumir margen pleno la incluiría sin fundamento. Las
 * dos falsean el resultado, en direcciones opuestas — se prefiere decir la
 * verdad incómoda: "$X de ventas no evaluables por costo faltante".
 */
export const evaluateMargin = (
  input: MarginInput,
  minMarginPct: Prisma.Decimal.Value | null,
): MarginVerdict => {
  if (minMarginPct === null) {
    // Sin regla de margen, todo pasa y todo es computable.
    return { computable: true, marginPct: ZERO, passes: true };
  }
  if (input.cost === null) return { computable: false };

  const ingreso = D(input.revenue);
  if (ingreso.isZero()) return { computable: false };

  const margen = ingreso.minus(D(input.cost)).dividedBy(ingreso).times(100);
  return {
    computable: true,
    marginPct: margen,
    passes: margen.greaterThanOrEqualTo(D(minMarginPct)),
  };
};

// ══════════════════════════════════════════════════════════════════════════
// Liquidación
// ══════════════════════════════════════════════════════════════════════════

export type SettlementEntry = {
  status: "PROVISIONAL" | "ELIGIBLE" | "REVERSED";
  commissionAmount: Prisma.Decimal.Value;
  marginKnown: boolean;
  baseAmount: Prisma.Decimal.Value;
};

export type SettlementTotals = {
  /** Lo que efectivamente se paga. Sólo asientos ELIGIBLE. */
  payable: Prisma.Decimal;
  /** Pronóstico a la espera de cobro. NO se paga. */
  provisional: Prisma.Decimal;
  /** Base que quedó fuera de la regla de margen por costo desconocido. */
  unevaluableBase: Prisma.Decimal;
};

/**
 * Totaliza un período.
 *
 * Regla dura: sólo `ELIGIBLE` es plata. Las reversiones son asientos ELIGIBLE
 * con monto negativo, así que la resta sale sola y el asiento original nunca
 * se toca.
 */
export const settlementTotals = (
  entries: SettlementEntry[],
): SettlementTotals => {
  let payable = ZERO;
  let provisional = ZERO;
  let unevaluableBase = ZERO;

  for (const entry of entries) {
    if (entry.status === "ELIGIBLE") {
      payable = payable.plus(D(entry.commissionAmount));
    } else if (entry.status === "PROVISIONAL") {
      provisional = provisional.plus(D(entry.commissionAmount));
    }
    if (!entry.marginKnown) {
      unevaluableBase = unevaluableBase.plus(D(entry.baseAmount));
    }
  }

  // Una liquidación negativa significaría descontarle plata del sueldo a
  // alguien por devoluciones de un período ya cobrado. Eso es una decisión
  // laboral, no un efecto colateral de un cálculo: se topea en cero y el
  // remanente queda visible en el extracto.
  return {
    payable: payable.isNegative() ? ZERO : money(payable),
    provisional: money(provisional),
    unevaluableBase: money(unevaluableBase),
  };
};

export type PeriodStatus =
  | "DRAFT"
  | "CALCULATED"
  | "REVIEWED"
  | "APPROVED"
  | "LOCKED"
  | "PAID";

/** Estados en los que el período ya no admite recálculo ni asientos nuevos. */
const CERRADOS: ReadonlySet<PeriodStatus> = new Set<PeriodStatus>([
  "LOCKED",
  "PAID",
]);

export const isClosed = (status: PeriodStatus): boolean => CERRADOS.has(status);

/**
 * Transiciones válidas del ciclo de vida.
 *
 * Se puede retroceder de APPROVED a REVIEWED (alguien vio un error antes de
 * pagar), pero de LOCKED y PAID no se vuelve: ahí ya hay un recibo emitido.
 */
const TRANSICIONES: Record<PeriodStatus, PeriodStatus[]> = {
  DRAFT: ["CALCULATED"],
  CALCULATED: ["REVIEWED", "CALCULATED"],
  REVIEWED: ["APPROVED", "CALCULATED"],
  APPROVED: ["LOCKED", "REVIEWED"],
  LOCKED: ["PAID"],
  PAID: [],
};

export const canTransition = (from: PeriodStatus, to: PeriodStatus): boolean =>
  TRANSICIONES[from].includes(to);

export const assertTransition = (
  from: PeriodStatus,
  to: PeriodStatus,
): void => {
  if (!canTransition(from, to)) {
    throw new IncentiveInvariantError(
      `No se puede pasar un período de ${from} a ${to}.`,
    );
  }
};

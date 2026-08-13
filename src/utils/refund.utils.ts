/**
 * Cómo se le devuelve la plata al cliente en una devolución.
 *
 * ── El agujero que esto cierra ──────────────────────────────────────────────
 *
 * `createReturn` restauraba el stock y, para una venta YA PAGADA, no registraba
 * ningún movimiento de dinero: ni `Payment` negativo, ni salida de caja, nada.
 * El cajón quedaba esperando más efectivo del que tenía, y al cerrar el turno
 * aparecía una diferencia que nadie podía explicar.
 *
 * ── Por qué no alcanza con "crear siempre un Payment negativo" ──────────────
 *
 * Sería tan falso como el problema original, en la dirección contraria:
 *
 *   · Devolución contra deuda IMPAGA → no sale un peso del cajón. Sólo baja lo
 *     que el cliente debe. Registrarla como salida haría faltar plata que nunca
 *     salió.
 *   · Devolución de una venta con tarjeta → la reversa la hace el Posnet, fuera
 *     de este sistema. Sacarla del cajón le quitaría efectivo real al negocio.
 *
 * ── La regla ────────────────────────────────────────────────────────────────
 *
 * 1. Primero se cancela contra lo que el cliente TODAVÍA DEBE. Esa parte no
 *    mueve dinero: la deuda simplemente baja.
 * 2. El resto es plata que el cliente ya entregó, y se devuelve **por donde
 *    entró**: la porción que se pagó en efectivo vuelve en efectivo, la de
 *    tarjeta se reversa, la de transferencia se transfiere.
 * 3. Nunca se devuelve más de lo económicamente reintegrable.
 *
 * **Sólo el efectivo físico afecta el arqueo.** Todo lo demás queda registrado
 * para poder conciliar, pero no toca el cajón.
 */

import { RefundSettlementKind } from "@prisma/client";
import { Prisma } from "@prisma/client";

import { toDecimal } from "./pricing.utils";

const roundMoney = (value: Prisma.Decimal): Prisma.Decimal =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/** El reintegro pedido no se puede liquidar como se pide. */
export class RefundSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefundSettlementError";
  }
}

export type PlannedSettlement = {
  kind: RefundSettlementKind;
  amount: Prisma.Decimal;
  reference?: string | null;
};

/** Métodos que representan plata que entró físicamente al cajón. */
const CASH_METHODS = new Set(["CASH"]);
/** Métodos que se reversan en la terminal de pago, fuera de este sistema. */
const CARD_METHODS = new Set(["DEBIT", "CREDIT"]);

/**
 * Arma el plan de reintegro a partir de cómo se pagó la venta y de cuánto se
 * debe todavía.
 *
 * @param totalRefund   monto a devolver
 * @param outstanding   saldo impago de la venta (`Sale.balance`)
 * @param payments      pagos originales, con signo (los negativos ya son
 *                      reintegros previos y se descuentan)
 */
export const planRefundSettlements = (
  totalRefund: Prisma.Decimal,
  outstanding: Prisma.Decimal,
  // `amount` puede llegar como `number` o como `Decimal` según si la extensión
  // del cliente de Prisma aplicó o no en ese `select`. `toDecimal` normaliza
  // ambos, así que se aceptan los dos en vez de forzar un cast en el llamador.
  payments: { paymentMethod: string; amount: number | Prisma.Decimal }[],
): PlannedSettlement[] => {
  const plan: PlannedSettlement[] = [];
  let pendiente = roundMoney(totalRefund);

  if (pendiente.lessThanOrEqualTo(0)) return plan;

  // ── 1. Contra la deuda impaga ──
  // Es donde vive la plata que el cliente todavía no entregó. Bajarla no mueve
  // el cajón.
  const contraDeuda = Prisma.Decimal.min(pendiente, roundMoney(outstanding));
  if (contraDeuda.greaterThan(0)) {
    plan.push({ kind: RefundSettlementKind.CUSTOMER_DEBT_CREDIT, amount: contraDeuda });
    pendiente = roundMoney(pendiente.minus(contraDeuda));
  }

  if (pendiente.lessThanOrEqualTo(0)) return plan;

  // ── 2. El resto, por donde entró ──
  // Se suma lo realmente cobrado por método. Los pagos negativos son
  // reintegros anteriores y restan: no se puede devolver dos veces lo mismo.
  const porMetodo = new Map<string, Prisma.Decimal>();
  for (const pago of payments) {
    const metodo = pago.paymentMethod.toUpperCase();
    porMetodo.set(
      metodo,
      (porMetodo.get(metodo) ?? new Prisma.Decimal(0)).plus(toDecimal(pago.amount)),
    );
  }

  const asignar = (metodos: Set<string>, kind: RefundSettlementKind) => {
    if (pendiente.lessThanOrEqualTo(0)) return;
    let disponible = new Prisma.Decimal(0);
    for (const [metodo, monto] of porMetodo) {
      if (metodos.has(metodo) && monto.greaterThan(0)) disponible = disponible.plus(monto);
    }
    const asignado = Prisma.Decimal.min(pendiente, roundMoney(disponible));
    if (asignado.greaterThan(0)) {
      plan.push({ kind, amount: asignado });
      pendiente = roundMoney(pendiente.minus(asignado));
    }
  };

  asignar(CASH_METHODS, RefundSettlementKind.CASH);
  asignar(CARD_METHODS, RefundSettlementKind.CARD_REVERSAL);
  asignar(new Set(["TRANSFER"]), RefundSettlementKind.TRANSFER);

  // ── 3. Lo que no encaja en ningún lado ──
  // Puede pasar si la venta se cobró por una vía que ya no admite reintegro
  // automático. Se reconoce la deuda con el cliente en vez de perderla.
  if (pendiente.greaterThan(0)) {
    plan.push({ kind: RefundSettlementKind.PENDING_REIMBURSEMENT, amount: pendiente });
  }

  return plan;
};

/**
 * Verifica que el efectivo a devolver esté realmente en el cajón.
 *
 * Sin esto, una devolución grande dejaría la caja en negativo — un estado
 * imposible en la realidad que arruina el arqueo del turno.
 */
export const assertCashAvailable = (
  plan: PlannedSettlement[],
  availableCash: Prisma.Decimal,
): void => {
  const enEfectivo = plan
    .filter((item) => item.kind === RefundSettlementKind.CASH)
    .reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0));

  if (enEfectivo.greaterThan(availableCash)) {
    throw new RefundSettlementError(
      `No hay efectivo suficiente en la caja para el reintegro: se necesitan ` +
        `$${enEfectivo.toFixed(2)} y hay $${availableCash.toFixed(2)}. ` +
        "Registrá el reintegro por otra vía o hacé un ingreso de efectivo primero.",
    );
  }
};

/** ¿Este tipo de liquidación mueve el cajón? Sólo uno. */
export const affectsCashRegister = (kind: RefundSettlementKind): boolean =>
  kind === RefundSettlementKind.CASH;

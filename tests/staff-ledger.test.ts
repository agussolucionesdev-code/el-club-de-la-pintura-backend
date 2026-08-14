/**
 * Aritmética del libro del personal.
 *
 * Estos tests defienden plata que se le descuenta del sueldo a una persona. Una
 * aritmética de saldos mal hecha no explota: sigue andando y devolviendo
 * números creíbles hasta que alguien reclama que le cobraron de más.
 *
 * Por eso hay tests basados en PROPIEDADES sobre secuencias generadas, además
 * de los casos puntuales: los saldos negativos aparecen en combinaciones que a
 * nadie se le ocurre escribir a mano.
 */

import { Prisma } from "@prisma/client";

import {
  activeReceivable,
  activeTransferred,
  assertTransferInvariants,
  computeStaffBalance,
  isLiveCycle,
  LedgerInvariantError,
  planReturnAllocation,
  resolveCycleStatus,
  resolveInternalPrice,
} from "../src/utils/staffLedger.utils";

const D = (v: number | string) => new Prisma.Decimal(v);
const n = (d: Prisma.Decimal) => d.toNumber();

describe("saldo del libro", () => {
  it("es cero sin asientos", () => {
    expect(n(computeStaffBalance([]))).toBe(0);
  });

  it("débitos suman, créditos restan", () => {
    const saldo = computeStaffBalance([
      { debit: 10000, credit: 0 }, // se llevó mercadería
      { debit: 5000, credit: 0 },
      { debit: 0, credit: 12000 }, // pagó
    ]);
    expect(n(saldo)).toBe(3000);
  });

  it("puede quedar a favor del empleado", () => {
    // Pagó de más, o devolvió más de lo que debía. No se recorta a cero: si
    // pasó, hay que verlo, no esconderlo.
    expect(n(computeStaffBalance([{ debit: 1000, credit: 2500 }]))).toBe(-1500);
  });

  it("no pierde centavos", () => {
    // Con float, 0.1 + 0.2 da 0.30000000000000004. Con Decimal, no.
    const saldo = computeStaffBalance(
      Array.from({ length: 30 }, () => ({ debit: "0.1", credit: 0 })),
    );
    expect(saldo.toFixed(2)).toBe("3.00");
  });
});

describe("cuenta por cobrar de una venta trasladada", () => {
  const venta = (
    balance: number,
    transferido: number,
    revertido = 0,
  ) => ({
    balance,
    transferredToStaffLedger: transferido,
    transferReversed: revertido,
  });

  it("sin traslado, la deuda vigente es el saldo entero", () => {
    expect(n(activeReceivable(venta(10000, 0)))).toBe(10000);
  });

  it("trasladada por completo, sale de Cuentas Corrientes", () => {
    // No porque digamos que se pagó: porque su parte quedó cubierta en el
    // libro del personal, que es donde vive esa deuda ahora.
    expect(n(activeReceivable(venta(10000, 10000)))).toBe(0);
  });

  it("trasladada a medias, cuenta sólo la porción del cliente", () => {
    expect(n(activeReceivable(venta(10000, 4000)))).toBe(6000);
  });

  it("revertir el traslado devuelve la deuda a Cuentas Corrientes", () => {
    expect(n(activeReceivable(venta(10000, 10000, 10000)))).toBe(10000);
    expect(n(activeTransferred(venta(10000, 10000, 10000)))).toBe(0);
  });
});

describe("🔒 devolución sobre mercadería trasladada", () => {
  const venta = (balance: number, transferido: number, revertido = 0) => ({
    balance,
    transferredToStaffLedger: transferido,
    transferReversed: revertido,
  });

  it("descarga PRIMERO al empleado, que es quien la tiene cargada", () => {
    const plan = planReturnAllocation(venta(10000, 10000), 3000);
    expect(n(plan.toStaffLedger)).toBe(3000);
    expect(n(plan.toCustomerAccount)).toBe(0);
  });

  it("el excedente recién ahí toca la cuenta del cliente", () => {
    // Trasladado $4.000 de un saldo de $10.000; se devuelven $6.000.
    const plan = planReturnAllocation(venta(10000, 4000), 6000);
    expect(n(plan.toStaffLedger)).toBe(4000);
    expect(n(plan.toCustomerAccount)).toBe(2000);
  });

  it("sin nada trasladado, va toda contra el cliente", () => {
    const plan = planReturnAllocation(venta(10000, 0), 2500);
    expect(n(plan.toStaffLedger)).toBe(0);
    expect(n(plan.toCustomerAccount)).toBe(2500);
  });

  it("rechaza un monto negativo", () => {
    expect(() => planReturnAllocation(venta(10000, 5000), -1)).toThrow(
      LedgerInvariantError,
    );
  });

  it("PROPIEDAD: la cuenta por cobrar NUNCA queda negativa", () => {
    // El bug original: `balance` bajaba con la devolución pero el trasladado
    // quedaba fijo, y la resta daba negativo. Se prueba sobre secuencias
    // generadas de devoluciones parciales, que es donde aparecía.
    for (let saldo = 1000; saldo <= 20000; saldo += 1300) {
      for (let trasladado = 0; trasladado <= saldo; trasladado += 700) {
        let v = venta(saldo, trasladado);
        let restante = saldo;

        // Se devuelve de a pedazos hasta agotar la venta.
        for (const pedazo of [0.3, 0.25, 0.2, 0.15, 0.1]) {
          const monto = Math.min(Math.round(saldo * pedazo), restante);
          if (monto <= 0) continue;

          const plan = planReturnAllocation(v, monto);
          expect(n(plan.toStaffLedger) + n(plan.toCustomerAccount)).toBeCloseTo(monto, 6);

          v = {
            balance: n(D(v.balance).minus(plan.toCustomerAccount)),
            transferredToStaffLedger: v.transferredToStaffLedger,
            transferReversed: n(D(v.transferReversed).plus(plan.toStaffLedger)),
          };
          restante -= monto;

          expect(n(activeReceivable(v))).toBeGreaterThanOrEqual(0);
          // Y lo revertido nunca supera lo trasladado.
          expect(n(D(v.transferReversed))).toBeLessThanOrEqual(
            n(D(v.transferredToStaffLedger)),
          );
        }
      }
    }
  });
});

describe("ciclos de traslado", () => {
  it("el estado se DERIVA de los montos, no se elige", () => {
    expect(resolveCycleStatus({ transferredAmount: 5000, reversedAmount: 0 })).toBe("ACTIVE");
    expect(resolveCycleStatus({ transferredAmount: 5000, reversedAmount: 2000 })).toBe(
      "PARTIALLY_REVERSED",
    );
    expect(resolveCycleStatus({ transferredAmount: 5000, reversedAmount: 5000 })).toBe(
      "FULLY_REVERSED",
    );
  });

  it("rechaza revertir más de lo trasladado", () => {
    // Sería devolverle a alguien plata que nunca se le cargó.
    expect(() =>
      resolveCycleStatus({ transferredAmount: 5000, reversedAmount: 5001 }),
    ).toThrow(LedgerInvariantError);
  });

  it("un ciclo totalmente revertido deja de ocupar el índice", () => {
    // Es lo que habilita re-trasladar la venta: con `saleId @unique` —mi
    // versión anterior— la base habría rechazado el segundo traslado.
    expect(isLiveCycle("ACTIVE")).toBe(true);
    expect(isLiveCycle("PARTIALLY_REVERSED")).toBe(true);
    expect(isLiveCycle("FULLY_REVERSED")).toBe(false);
  });
});

describe("🔒 invariantes antes de committear", () => {
  const venta = (balance: number, transferido: number, revertido = 0) => ({
    balance,
    transferredToStaffLedger: transferido,
    transferReversed: revertido,
  });

  it("acepta un traslado coherente", () => {
    expect(() =>
      assertTransferInvariants(venta(10000, 6000, 1000), [
        { transferredAmount: 6000, reversedAmount: 1000 },
      ]),
    ).not.toThrow();
  });

  it("acepta un ciclo cerrado más uno nuevo (re-traslado)", () => {
    // Ciclo 1 revertido entero, ciclo 2 vivo. Los acumulados suman los dos.
    expect(() =>
      assertTransferInvariants(venta(10000, 9000, 4000), [
        { transferredAmount: 4000, reversedAmount: 4000 }, // cerrado
        { transferredAmount: 5000, reversedAmount: 0 }, //    vivo
      ]),
    ).not.toThrow();
  });

  it("rechaza DOS ciclos vivos sobre la misma venta", () => {
    // Duplicaría la deuda de una persona.
    expect(() =>
      assertTransferInvariants(venta(10000, 8000), [
        { transferredAmount: 4000, reversedAmount: 0 },
        { transferredAmount: 4000, reversedAmount: 0 },
      ]),
    ).toThrow(/ciclos vivos/u);
  });

  it("rechaza acumulados que no cierran con los ciclos", () => {
    expect(() =>
      assertTransferInvariants(venta(10000, 7000), [
        { transferredAmount: 4000, reversedAmount: 0 },
      ]),
    ).toThrow(/no cierran/u);
  });

  it("rechaza trasladar más deuda de la que la venta tiene", () => {
    expect(() =>
      assertTransferInvariants(venta(5000, 8000), [
        { transferredAmount: 8000, reversedAmount: 0 },
      ]),
    ).toThrow(/no se puede trasladar más deuda/iu);
  });
});

describe("política de precio del consumo interno", () => {
  const base = { listPrice: 10000, costPrice: 4000 };

  it("aplica cada política", () => {
    expect(n(resolveInternalPrice({ ...base, policy: "RETAIL" }))).toBe(10000);
    expect(n(resolveInternalPrice({ ...base, policy: "COST" }))).toBe(4000);
    expect(n(resolveInternalPrice({ ...base, policy: "COST_PLUS", rate: 25 }))).toBe(5000);
    expect(n(resolveInternalPrice({ ...base, policy: "STAFF_DISCOUNT", rate: 30 }))).toBe(7000);
    expect(
      n(resolveInternalPrice({ ...base, policy: "EXPLICIT", explicitPrice: 6500 })),
    ).toBe(6500);
  });

  it("🔒 sin costo cargado, NO cae a cero", () => {
    // Cargarle $0 a un empleado por un vacío de datos sería regalarle
    // mercadería. Un costo desconocido no es cero (regla de la Fase 2).
    expect(() =>
      resolveInternalPrice({ listPrice: 10000, costPrice: null, policy: "COST" }),
    ).toThrow(/no tiene costo cargado/u);

    expect(() =>
      resolveInternalPrice({
        listPrice: 10000,
        costPrice: null,
        policy: "COST_PLUS",
        rate: 20,
      }),
    ).toThrow(LedgerInvariantError);
  });

  it("un precio excepcional exige que se diga cuál es", () => {
    expect(() => resolveInternalPrice({ ...base, policy: "EXPLICIT" })).toThrow(
      LedgerInvariantError,
    );
  });

  it("no pierde centavos con porcentajes", () => {
    const precio = resolveInternalPrice({
      listPrice: "3333.33",
      policy: "STAFF_DISCOUNT",
      rate: "33.33",
    });
    // 3333,33 × 66,67 / 100 = 2222,331111 — calculado a mano para que el test
    // no sea el código repitiéndose a sí mismo.
    expect(precio.toFixed(4)).toBe("2222.3311");
  });
});

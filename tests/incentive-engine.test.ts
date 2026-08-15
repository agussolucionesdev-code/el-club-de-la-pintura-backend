/**
 * Motor de incentivos: aritmética pura, sin base de datos.
 *
 * Estos tests son la red de seguridad del número que termina en el recibo de
 * sueldo de una persona real. Se prueban los bordes que rompen en la vida real:
 * la venta de las 22:00 del último día del mes, el escalón que se cruza a la
 * mitad de una operación, el costo desconocido, y la liquidación que daría
 * negativa por devoluciones.
 */
import { Prisma } from "@prisma/client";

import {
  assertTransition,
  canTransition,
  computeCommission,
  evaluateMargin,
  IncentiveInvariantError,
  isClosed,
  outstandingProvisional,
  periodBounds,
  resolvePeriodKey,
  settlementTotals,
  splitEligibility,
  type PeriodStatus,
  type Rule,
} from "../src/utils/incentive.utils";

const regla = (over: Partial<Rule> & Pick<Rule, "id" | "kind">): Rule => ({
  percent: null,
  fromAmount: null,
  toAmount: null,
  fixedAmount: null,
  targetAmount: null,
  ...over,
});

/** Instante UTC que corresponde a una hora de pared argentina (UTC−3). */
const enArgentina = (
  y: number,
  m: number,
  d: number,
  h = 12,
  min = 0,
): Date => new Date(Date.UTC(y, m - 1, d, h + 3, min));

describe("períodos", () => {
  it("mensual: una venta de las 22:00 del último día NO se va al mes siguiente", () => {
    // Este es el bug clásico. A las 22:00 del 31/08 en Argentina son las 01:00
    // UTC del 01/09. Un servidor en UTC le pagaría esa comisión a septiembre.
    const finDeAgosto = enArgentina(2026, 8, 31, 22, 0);
    expect(finDeAgosto.toISOString()).toContain("2026-09-01"); // en UTC ya es septiembre
    expect(resolvePeriodKey(finDeAgosto, "MONTHLY")).toBe("2026-08");
  });

  it("mensual: la medianoche del día 1 pertenece al mes que arranca", () => {
    expect(resolvePeriodKey(enArgentina(2026, 9, 1, 0, 0), "MONTHLY")).toBe(
      "2026-09",
    );
  });

  it("quincenal: el 15 es primera quincena y el 16 es segunda", () => {
    expect(resolvePeriodKey(enArgentina(2026, 8, 15, 23), "BIWEEKLY")).toBe(
      "2026-08-Q1",
    );
    expect(resolvePeriodKey(enArgentina(2026, 8, 16, 0), "BIWEEKLY")).toBe(
      "2026-08-Q2",
    );
  });

  it("semanal: lunes y domingo caen en la misma semana ISO", () => {
    const lunes = enArgentina(2026, 8, 10, 9);
    const domingo = enArgentina(2026, 8, 16, 21);
    const clave = resolvePeriodKey(lunes, "WEEKLY");
    expect(resolvePeriodKey(domingo, "WEEKLY")).toBe(clave);
    // El lunes siguiente ya es otra.
    expect(resolvePeriodKey(enArgentina(2026, 8, 17, 9), "WEEKLY")).not.toBe(
      clave,
    );
  });

  it("los límites del período contienen exactamente a su clave", () => {
    for (const cadencia of ["MONTHLY", "BIWEEKLY", "WEEKLY"] as const) {
      const instante = enArgentina(2026, 8, 20, 14);
      const clave = resolvePeriodKey(instante, cadencia);
      const { startsAt, endsAt } = periodBounds(clave, cadencia);
      expect(startsAt.getTime()).toBeLessThanOrEqual(instante.getTime());
      expect(endsAt.getTime()).toBeGreaterThan(instante.getTime());
      // El fin es EXCLUSIVO: pertenece al período siguiente.
      expect(resolvePeriodKey(endsAt, cadencia)).not.toBe(clave);
      // Y un milisegundo antes todavía es el nuestro.
      expect(resolvePeriodKey(new Date(endsAt.getTime() - 1), cadencia)).toBe(
        clave,
      );
    }
  });

  it("no quedan huecos entre períodos consecutivos", () => {
    const agosto = periodBounds("2026-08", "MONTHLY");
    const septiembre = periodBounds("2026-09", "MONTHLY");
    expect(agosto.endsAt.getTime()).toBe(septiembre.startsAt.getTime());
  });

  it("rechaza una clave con formato inválido", () => {
    expect(() => periodBounds("agosto", "MONTHLY")).toThrow(
      IncentiveInvariantError,
    );
  });
});

describe("elegibilidad", () => {
  it("ON_SALE: todo se gana al vender, aunque no haya entrado un peso", () => {
    const r = splitEligibility("ON_SALE", { totalBase: 10000, collectedNow: 0 });
    expect(r.eligibleBase.toString()).toBe("10000");
    expect(r.provisionalBase.toString()).toBe("0");
  });

  it("ON_COLLECTION: nada se gana al vender, aunque se haya cobrado todo", () => {
    const r = splitEligibility("ON_COLLECTION", {
      totalBase: 10000,
      collectedNow: 10000,
    });
    expect(r.eligibleBase.toString()).toBe("0");
    expect(r.provisionalBase.toString()).toBe("10000");
  });

  it("MIXED: lo cobrado es elegible y el fiado queda provisional", () => {
    const r = splitEligibility("MIXED", {
      totalBase: 10000,
      collectedNow: 6000,
    });
    expect(r.eligibleBase.toString()).toBe("6000");
    expect(r.provisionalBase.toString()).toBe("4000");
  });

  it("MIXED: un cobro mayor que la base no genera elegible de más", () => {
    // Pasa de verdad: devolución parcial que baja la base sin devolver la plata.
    const r = splitEligibility("MIXED", {
      totalBase: 8000,
      collectedNow: 10000,
    });
    expect(r.eligibleBase.toString()).toBe("8000");
    expect(r.provisionalBase.toString()).toBe("0");
  });

  it("rechaza una base negativa", () => {
    expect(() =>
      splitEligibility("MIXED", { totalBase: -1, collectedNow: 0 }),
    ).toThrow(IncentiveInvariantError);
  });

  it("el remanente provisional se deriva y nunca es negativo", () => {
    expect(outstandingProvisional(4000, 1500).toString()).toBe("2500");
    expect(outstandingProvisional(4000, 4000).toString()).toBe("0");
    expect(outstandingProvisional(4000, 9999).toString()).toBe("0");
  });
});

describe("cálculo del monto", () => {
  it("porcentaje plano", () => {
    const reglas = [
      regla({ id: 1, kind: "PERCENT_OF_SALES", percent: "2.5" }),
    ];
    const r = computeCommission(reglas, 100000);
    expect(r.amount.toString()).toBe("2500");
    expect(r.snapshot.ruleId).toBe(1);
    expect(r.snapshot.percent).toBe("2.5");
  });

  it("redondea a dos decimales, medio arriba", () => {
    const reglas = [regla({ id: 1, kind: "PERCENT_OF_SALES", percent: "3" })];
    // 1234.55 * 3% = 37.0365 → 37.04
    expect(computeCommission(reglas, "1234.55").amount.toString()).toBe("37.04");
  });

  describe("escalones", () => {
    const escalones = [
      regla({
        id: 10,
        kind: "TIERED_PERCENT",
        percent: "3",
        fromAmount: 0,
        toAmount: 500000,
      }),
      regla({
        id: 11,
        kind: "TIERED_PERCENT",
        percent: "4",
        fromAmount: 500000,
        toAmount: null,
      }),
    ];

    it("son MARGINALES: sólo el excedente paga el porcentaje mayor", () => {
      // Lleva $480.000 y vende $40.000: $20.000 al 3% y $20.000 al 4%.
      const r = computeCommission(escalones, 40000, 480000);
      expect(r.amount.toString()).toBe("1400"); // 600 + 800
    });

    it("no hay salto al cruzar la meta", () => {
      // Vender un peso más nunca puede pagar miles más: eso se manipula.
      const antes = computeCommission(escalones, 1, 499999).amount;
      const despues = computeCommission(escalones, 1, 500000).amount;
      expect(despues.minus(antes).abs().lessThan(1)).toBe(true);
    });

    it("vender en una operación paga igual que vender en diez", () => {
      const deUnaVez = computeCommission(escalones, 600000, 0).amount;

      let acumulado = new Prisma.Decimal(0);
      let total = new Prisma.Decimal(0);
      for (let i = 0; i < 10; i += 1) {
        total = total.plus(computeCommission(escalones, 60000, acumulado).amount);
        acumulado = acumulado.plus(60000);
      }
      expect(total.toString()).toBe(deUnaVez.toString());
    });
  });

  describe("monto fijo por meta", () => {
    const fija = [
      regla({
        id: 20,
        kind: "FIXED_ON_TARGET",
        fixedAmount: 50000,
        targetAmount: 300000,
      }),
    ];

    it("paga sólo en la operación que cruza la meta", () => {
      expect(computeCommission(fija, 100000, 0).amount.toString()).toBe("0");
      expect(computeCommission(fija, 100000, 250000).amount.toString()).toBe(
        "50000",
      );
      // Y no vuelve a pagar después.
      expect(computeCommission(fija, 100000, 350000).amount.toString()).toBe(
        "0",
      );
    });

    it("el premio se paga UNA sola vez en todo el período", () => {
      let acumulado = new Prisma.Decimal(0);
      let total = new Prisma.Decimal(0);
      for (let i = 0; i < 20; i += 1) {
        total = total.plus(computeCommission(fija, 50000, acumulado).amount);
        acumulado = acumulado.plus(50000);
      }
      expect(total.toString()).toBe("50000");
    });
  });

  it("falla ruidosamente si el plan no tiene reglas", () => {
    expect(() => computeCommission([], 1000)).toThrow(IncentiveInvariantError);
  });

  it("falla si la regla de porcentaje no tiene porcentaje cargado", () => {
    expect(() =>
      computeCommission([regla({ id: 1, kind: "PERCENT_OF_SALES" })], 1000),
    ).toThrow(/no tiene porcentaje/u);
  });
});

describe("margen mínimo", () => {
  it("sin regla de margen, todo computa", () => {
    const v = evaluateMargin({ revenue: 1000, cost: null }, null);
    expect(v.computable).toBe(true);
  });

  it("costo DESCONOCIDO no es costo cero: queda fuera y se reporta", () => {
    const v = evaluateMargin({ revenue: 1000, cost: null }, 20);
    expect(v.computable).toBe(false);
  });

  it("costo genuinamente cero SÍ computa, y da 100% de margen", () => {
    const v = evaluateMargin({ revenue: 1000, cost: 0 }, 20);
    expect(v).toMatchObject({ computable: true, passes: true });
    if (v.computable) expect(v.marginPct.toString()).toBe("100");
  });

  it("distingue por encima y por debajo del mínimo", () => {
    const bueno = evaluateMargin({ revenue: 1000, cost: 700 }, 25);
    const malo = evaluateMargin({ revenue: 1000, cost: 800 }, 25);
    expect(bueno).toMatchObject({ computable: true, passes: true });
    expect(malo).toMatchObject({ computable: true, passes: false });
  });

  it("el mínimo exacto pasa", () => {
    const v = evaluateMargin({ revenue: 1000, cost: 750 }, 25);
    expect(v).toMatchObject({ passes: true });
  });
});

describe("liquidación", () => {
  it("sólo ELIGIBLE es plata; PROVISIONAL nunca se paga", () => {
    const t = settlementTotals([
      { status: "ELIGIBLE", commissionAmount: 5000, marginKnown: true, baseAmount: 100000 },
      { status: "PROVISIONAL", commissionAmount: 3000, marginKnown: true, baseAmount: 60000 },
      { status: "REVERSED", commissionAmount: 999, marginKnown: true, baseAmount: 0 },
    ]);
    expect(t.payable.toString()).toBe("5000");
    expect(t.provisional.toString()).toBe("3000");
  });

  it("una reversión es un ELIGIBLE negativo y resta sola", () => {
    const t = settlementTotals([
      { status: "ELIGIBLE", commissionAmount: 5000, marginKnown: true, baseAmount: 100000 },
      { status: "ELIGIBLE", commissionAmount: -1200, marginKnown: true, baseAmount: -24000 },
    ]);
    expect(t.payable.toString()).toBe("3800");
  });

  it("nunca liquida negativo: descontar del sueldo es otra decisión", () => {
    const t = settlementTotals([
      { status: "ELIGIBLE", commissionAmount: 1000, marginKnown: true, baseAmount: 20000 },
      { status: "ELIGIBLE", commissionAmount: -4000, marginKnown: true, baseAmount: -80000 },
    ]);
    expect(t.payable.toString()).toBe("0");
  });

  it("reporta aparte la base no evaluable por costo faltante", () => {
    const t = settlementTotals([
      { status: "ELIGIBLE", commissionAmount: 5000, marginKnown: true, baseAmount: 100000 },
      { status: "ELIGIBLE", commissionAmount: 0, marginKnown: false, baseAmount: 33000 },
    ]);
    expect(t.unevaluableBase.toString()).toBe("33000");
  });
});

describe("ciclo de vida del período", () => {
  it("recorre el ciclo completo", () => {
    const camino: PeriodStatus[] = [
      "DRAFT",
      "CALCULATED",
      "REVIEWED",
      "APPROVED",
      "LOCKED",
      "PAID",
    ];
    for (let i = 0; i < camino.length - 1; i += 1) {
      expect(canTransition(camino[i]!, camino[i + 1]!)).toBe(true);
    }
  });

  it("permite volver atrás antes de pagar, pero no después", () => {
    expect(canTransition("APPROVED", "REVIEWED")).toBe(true);
    expect(canTransition("REVIEWED", "CALCULATED")).toBe(true);
    expect(canTransition("LOCKED", "APPROVED")).toBe(false);
    expect(canTransition("PAID", "LOCKED")).toBe(false);
  });

  it("no se saltea la aprobación", () => {
    expect(canTransition("CALCULATED", "PAID")).toBe(false);
    expect(() => assertTransition("DRAFT", "PAID")).toThrow(
      IncentiveInvariantError,
    );
  });

  it("LOCKED y PAID están cerrados a recálculo", () => {
    expect(isClosed("LOCKED")).toBe(true);
    expect(isClosed("PAID")).toBe(true);
    expect(isClosed("APPROVED")).toBe(false);
  });
});

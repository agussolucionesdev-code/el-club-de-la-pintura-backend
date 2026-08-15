/**
 * El contrato de los movimientos de efectivo.
 *
 * ── Qué se está defendiendo ─────────────────────────────────────────────────
 *
 * `CashMovement.type` es un `String` suelto en la base. El módulo de caja
 * escribe y lee `"IN"` / `"OUT"`; el libro del personal, escrito meses después
 * en otro archivo, guardó `"INCOME"` para el cobro en efectivo de una cuenta de
 * empleado. Postgres lo aceptó sin chistar.
 *
 * La plata entraba al cajón de verdad, pero el arqueo no la contaba: el turno
 * cerraba con un SOBRANTE inexplicable, exactamente igual a lo que los
 * empleados hubieran pagado en efectivo.
 *
 * Y el defecto de fondo no era el typo: era que la suma descartaba en silencio
 * todo lo que no reconocía. Una diferencia de caja sin causa visible es de las
 * cosas más caras de diagnosticar en un negocio, porque la sospecha cae sobre
 * las personas antes que sobre el software.
 */

import { CASH_IN, CASH_OUT, isCashMovementType, sumCashMovements } from "../src/utils/cashMovement.utils";

describe("suma de movimientos de efectivo", () => {
  it("suma los ingresos y resta los retiros", () => {
    const t = sumCashMovements([
      { type: CASH_IN, amount: 5000 },
      { type: CASH_IN, amount: 2500 },
      { type: CASH_OUT, amount: 3000 },
    ]);
    expect(t.totalIn).toBe(7500);
    expect(t.totalOut).toBe(3000);
    expect(t.unclassified.count).toBe(0);
  });

  it("un tipo desconocido NO desaparece: se informa aparte", () => {
    // Éste es el test que caza el bug. Antes, `"INCOME"` no entraba en ninguna
    // de las dos ramas y simplemente se esfumaba del efectivo esperado.
    const t = sumCashMovements([
      { type: CASH_IN, amount: 1000 },
      { type: "INCOME", amount: 4000 },
    ]);

    expect(t.totalIn).toBe(1000);
    expect(t.unclassified).toEqual({
      count: 1,
      total: 4000,
      types: ["INCOME"],
    });
  });

  it("agrupa varios tipos raros sin repetirlos", () => {
    const t = sumCashMovements([
      { type: "INCOME", amount: 100 },
      { type: "INCOME", amount: 200 },
      { type: "EGRESO", amount: 50 },
    ]);
    expect(t.unclassified.count).toBe(3);
    expect(t.unclassified.total).toBe(350);
    expect(t.unclassified.types.sort()).toEqual(["EGRESO", "INCOME"]);
  });

  it("sin movimientos da cero y no rompe", () => {
    const t = sumCashMovements([]);
    expect(t).toMatchObject({ totalIn: 0, totalOut: 0 });
    expect(t.unclassified.count).toBe(0);
  });

  it("distingue los tipos válidos de los que no lo son", () => {
    expect(isCashMovementType("IN")).toBe(true);
    expect(isCashMovementType("OUT")).toBe(true);
    for (const invalido of ["INCOME", "EXPENSE", "in", "Out", "", "INGRESO"]) {
      expect(isCashMovementType(invalido)).toBe(false);
    }
  });
});

describe("ningún módulo escribe un tipo que la caja no lea", () => {
  it("el libro del personal usa la constante compartida, no un string suelto", () => {
    // Se lee el archivo en vez de simular el flujo entero: lo que se quiere
    // impedir es que alguien vuelva a escribir un literal ahí. Si el día de
    // mañana aparece otro `type: "ALGO"` en un `cashMovement.create`, este test
    // se pone rojo y obliga a pasar por la constante.
    const fs = require("fs") as typeof import("fs");
    const fuente = fs.readFileSync(
      require.resolve("../src/modules/staff/staff.controller.ts"),
      "utf8",
    );

    const creaciones = fuente.match(/cashMovement\.create\([\s\S]{0,1500}?\}\)/gu) ?? [];
    expect(creaciones.length).toBeGreaterThan(0);

    for (const bloque of creaciones) {
      // Tiene que usar la constante...
      expect(bloque).toContain("type: CASH_IN");
      // ...y no un literal escrito a mano.
      expect(bloque).not.toMatch(/type:\s*"(?!.*CASH_)/u);
    }
  });
});

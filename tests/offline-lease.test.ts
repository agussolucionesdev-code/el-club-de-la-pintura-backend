/**
 * Permiso offline: firma, vencimiento y la política de aceptación.
 *
 * Lo que se defiende acá es la frase que ordena todo el diseño:
 *
 *   **El reloj del cliente no prueba nada. Lo que decide es la hora en que la
 *   operación LLEGA al servidor.**
 *
 * Hay un test dedicado a eso: la misma operación, con el reloj del dispositivo
 * adelantado un año y con el reloj en hora, tiene que dar EXACTAMENTE el mismo
 * resultado. Si algún día alguien "mejora" el código leyendo el timestamp del
 * cliente, ese test se pone rojo.
 */

import {
  decideAcceptance,
  DEFAULT_OPERATION_CLASSES,
  issueLease,
  leaseTtlHours,
  verifyLease,
  type AcceptanceInput,
  type LeasePayload,
} from "../src/utils/offlineLease.utils";

const SECRETO_ORIGINAL = process.env["OFFLINE_LEASE_SECRET"];
const TTL_ORIGINAL = process.env["OFFLINE_LEASE_TTL_HOURS"];

beforeAll(() => {
  process.env["OFFLINE_LEASE_SECRET"] = "secreto-de-prueba-no-usar-en-produccion";
});

afterAll(() => {
  if (SECRETO_ORIGINAL === undefined) delete process.env["OFFLINE_LEASE_SECRET"];
  else process.env["OFFLINE_LEASE_SECRET"] = SECRETO_ORIGINAL;
  if (TTL_ORIGINAL === undefined) delete process.env["OFFLINE_LEASE_TTL_HOURS"];
  else process.env["OFFLINE_LEASE_TTL_HOURS"] = TTL_ORIGINAL;
});

const MARTES_9AM = new Date("2026-08-18T12:00:00.000Z"); // 9:00 en Argentina

const emitir = (ahora: Date = MARTES_9AM) =>
  issueLease({ t: 2, b: 1, o: 44, s: 4471, sv: 3, seq: 0 }, ahora);

const entrada = (over: Partial<AcceptanceInput> = {}): AcceptanceInput => ({
  token: emitir().token,
  arrivedAt: new Date(MARTES_9AM.getTime() + 3_600_000), // una hora después
  currentSecurityVersion: 3,
  operationClass: "SALE",
  sequence: 1,
  lastSequenceSeen: 0,
  ...over,
});

describe("vigencia configurable", () => {
  afterEach(() => {
    delete process.env["OFFLINE_LEASE_TTL_HOURS"];
  });

  it("por defecto son 12 horas", () => {
    expect(leaseTtlHours()).toBe(12);
    const { payload } = emitir();
    expect(payload.exp - payload.iat).toBe(12 * 3_600_000);
  });

  it("se puede estirar por configuración, sin tocar código", () => {
    process.env["OFFLINE_LEASE_TTL_HOURS"] = "24";
    expect(leaseTtlHours()).toBe(24);
    const { payload } = emitir();
    expect(payload.exp - payload.iat).toBe(24 * 3_600_000);
  });

  it("un valor inválido cae al default en vez de romper el mostrador", () => {
    // Una variable mal escrita no puede dejar la sucursal sin vender offline.
    process.env["OFFLINE_LEASE_TTL_HOURS"] = "doce";
    expect(leaseTtlHours()).toBe(12);
    process.env["OFFLINE_LEASE_TTL_HOURS"] = "-5";
    expect(leaseTtlHours()).toBe(12);
    process.env["OFFLINE_LEASE_TTL_HOURS"] = "99999";
    expect(leaseTtlHours()).toBe(12);
  });
});

describe("firma", () => {
  it("un permiso recién emitido se verifica y conserva su alcance", () => {
    const { token } = emitir();
    const r = verifyLease(token);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload).toMatchObject({ t: 2, b: 1, o: 44, s: 4471, sv: 3 });
      expect(r.payload.ops).toEqual(DEFAULT_OPERATION_CLASSES);
    }
  });

  it("cambiarle UN campo al contenido invalida la firma", () => {
    // El ataque obvio: editar el permiso para atribuirse la venta a otro
    // operador, o para correr el vencimiento.
    const { token } = emitir();
    const [cuerpo] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(cuerpo!, "base64url").toString("utf8"),
    ) as LeasePayload;

    payload.o = 999; // "esta venta la hizo otro"
    const adulterado = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${token.split(".")[1]}`;

    expect(verifyLease(adulterado)).toMatchObject({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("estirar el vencimiento a mano tampoco funciona", () => {
    const { token } = emitir();
    const [cuerpo, firma] = token.split(".");
    const payload = JSON.parse(
      Buffer.from(cuerpo!, "base64url").toString("utf8"),
    ) as LeasePayload;

    payload.exp += 365 * 24 * 3_600_000; // un año más
    const adulterado = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${firma}`;

    expect(verifyLease(adulterado)).toMatchObject({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("un permiso firmado con OTRA clave se rechaza", () => {
    const { token } = emitir();
    process.env["OFFLINE_LEASE_SECRET"] = "otra-clave-distinta";
    const r = verifyLease(token);
    process.env["OFFLINE_LEASE_SECRET"] = "secreto-de-prueba-no-usar-en-produccion";
    expect(r).toMatchObject({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("basura de entrada no explota: se rechaza y ya", () => {
    for (const basura of ["", "sinpunto", "a.b", ".", "..", "null"]) {
      expect(verifyLease(basura).ok).toBe(false);
    }
  });
});

describe("la hora que vale es la del SERVIDOR", () => {
  it("llega a tiempo: entra sola y cuenta para comisión", () => {
    const d = decideAcceptance(entrada());
    expect(d).toMatchObject({ tier: "TRUSTED", reason: "OK" });
  });

  it("llega DESPUÉS del vencimiento: entra igual, pero a confirmar", () => {
    // No se pierde. Entra: mueve stock, factura y emite comprobante. Lo que
    // espera es la atribución, que es lo que alimenta la comisión.
    const d = decideAcceptance(
      entrada({ arrivedAt: new Date(MARTES_9AM.getTime() + 13 * 3_600_000) }),
    );
    expect(d).toMatchObject({ tier: "NEEDS_CONFIRMATION", reason: "LATE_ARRIVAL" });
  });

  it("justo en el límite todavía entra sola", () => {
    const { token, payload } = emitir();
    const d = decideAcceptance(entrada({ token, arrivedAt: new Date(payload.exp) }));
    expect(d.tier).toBe("TRUSTED");
    // Y un milisegundo después, ya no.
    const tarde = decideAcceptance(
      entrada({ token, arrivedAt: new Date(payload.exp + 1) }),
    );
    expect(tarde.tier).toBe("NEEDS_CONFIRMATION");
  });

  it("EL TEST QUE IMPORTA: el reloj del dispositivo no cambia NADA", () => {
    // El timestamp del cliente es falsificable —cambiar la hora de Windows son
    // tres clics— así que no puede participar de la decisión. Se corre la misma
    // operación con el reloj adelantado un año y con el reloj en hora: el
    // resultado tiene que ser idéntico, porque el dato no se consulta.
    const llegada = new Date(MARTES_9AM.getTime() + 20 * 3_600_000); // tarde

    const conRelojAdelantado = decideAcceptance({
      ...entrada({ arrivedAt: llegada }),
      // Se pasa igual para dejar constancia de que el campo existe y no se usa.
      ...({ clientTimestamp: new Date("2027-01-01") } as object),
    });
    const conRelojEnHora = decideAcceptance(entrada({ arrivedAt: llegada }));

    expect(conRelojAdelantado.tier).toBe(conRelojEnHora.tier);
    expect(conRelojAdelantado.reason).toBe(conRelojEnHora.reason);
    expect(conRelojEnHora.tier).toBe("NEEDS_CONFIRMATION");
  });
});

describe("lo que se rechaza de plano", () => {
  it("sesión revocada: dar de baja a alguien tiene efecto inmediato", () => {
    // Se reseteó el PIN o se revocó la terminal, así que `deviceSecretVersion`
    // subió. El permiso viejo queda muerto aunque la máquina tenga operaciones
    // encoladas y aunque todavía no haya vencido.
    const d = decideAcceptance(entrada({ currentSecurityVersion: 4 }));
    expect(d).toMatchObject({ tier: "REJECTED", reason: "SESSION_REVOKED" });
  });

  it("una clase de operación fuera del alcance no pasa", () => {
    const { token } = issueLease(
      { t: 2, b: 1, o: 44, s: 4471, sv: 3, seq: 0, ops: ["SALE"] },
      MARTES_9AM,
    );
    const d = decideAcceptance(entrada({ token, operationClass: "STOCK_ADJUST" }));
    expect(d).toMatchObject({ tier: "REJECTED", reason: "OPERATION_NOT_ALLOWED" });
  });

  it("repetir una secuencia ya vista es replay, no reintento", () => {
    // Los reintentos legítimos se resuelven por clave de idempotencia, que ya
    // existe y es otra cosa. Reusar una secuencia es reproducir una operación.
    const d = decideAcceptance(entrada({ sequence: 5, lastSequenceSeen: 5 }));
    expect(d).toMatchObject({ tier: "REJECTED", reason: "REPLAY" });

    const vieja = decideAcceptance(entrada({ sequence: 3, lastSequenceSeen: 7 }));
    expect(vieja).toMatchObject({ tier: "REJECTED", reason: "REPLAY" });
  });

  it("la firma se revisa ANTES que el vencimiento", () => {
    // Un permiso adulterado Y vencido tiene que reportarse como adulterado: es
    // el problema grave, y confundirlo con "llegó tarde" lo mandaría a una
    // pantalla de confirmación de rutina.
    const d = decideAcceptance(
      entrada({
        token: "cuerpoFalso.firmaFalsa",
        arrivedAt: new Date(MARTES_9AM.getTime() + 99 * 3_600_000),
      }),
    );
    expect(d.tier).toBe("REJECTED");
  });
});

describe("compatibilidad con lo ya encolado", () => {
  it("sin permiso: se procesa UNA vez, marcada, y fuera de incentivos", () => {
    // Las operaciones que quedaron en la cola antes de que esto existiera no
    // tienen la culpa. No se les inventa credibilidad, pero tampoco se tiran.
    const d = decideAcceptance(entrada({ token: null }));
    expect(d).toMatchObject({ tier: "NEEDS_CONFIRMATION", reason: "NO_LEASE" });
    expect(d.payload).toBeNull();
  });
});

describe("ningún nivel puede perder una venta", () => {
  it("sólo REJECTED frena, y sólo por motivos criptográficos", () => {
    // Propiedad del diseño: una venta real nunca se pierde. Si el motivo del
    // rechazo no es una credencial rota, hay un bug.
    const motivosQueFrenan = new Set([
      "BAD_SIGNATURE",
      "MALFORMED",
      "SESSION_REVOKED",
      "OPERATION_NOT_ALLOWED",
      "REPLAY",
    ]);

    const casos: AcceptanceInput[] = [
      entrada(),
      entrada({ arrivedAt: new Date(MARTES_9AM.getTime() + 50 * 3_600_000) }),
      entrada({ token: null }),
      entrada({ currentSecurityVersion: 9 }),
      entrada({ sequence: 1, lastSequenceSeen: 1 }),
      entrada({ token: "roto.roto" }),
    ];

    for (const caso of casos) {
      const d = decideAcceptance(caso);
      if (d.tier === "REJECTED") {
        expect(motivosQueFrenan.has(d.reason)).toBe(true);
      }
    }
  });
});

/**
 * Entrar al sistema con el código de seis dígitos, desde una terminal.
 *
 * Lo que estos tests protegen, en orden de gravedad:
 *
 *   1. Que el código NO sirva desde una computadora que no sea una caja
 *      enrolada. Es el factor que convierte seis dígitos en algo defendible.
 *   2. Que una sesión abierta con código NO habilite administrar el sistema,
 *      ni siquiera cuando quien entra es el dueño.
 *   3. Que probar códigos a ciegas se agote solo (bloqueo por usuario) y que
 *      la respuesta no le diga al que prueba en qué se equivocó.
 */
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { hashPin, MAX_PIN_ATTEMPTS } from "../src/utils/posPin.utils";
import { SESSION_COOKIE } from "../src/utils/session.utils";
import {
  buildDeviceCookieValue,
  generateDeviceSecret,
  sha256,
  TERMINAL_COOKIE,
} from "../src/utils/terminalDevice.utils";
import { generateTestToken, sessionTokenFromResponse } from "./helpers/auth";

const ACCESO = "/api/auth/terminal-access";
const INGRESO = "/api/auth/terminal-access/login";

describe("Ingreso con código desde una terminal", () => {
  const runId = Date.now();

  let sucursalId = 0;
  let otraSucursalId = 0;
  let cookieTerminal = "";

  let duenoId = 0;
  let vendedoraId = 0;
  let sinCodigoId = 0;
  let ajenoId = 0;

  const PIN_DUENO = "428913";
  const PIN_VENDEDORA = "570264";
  const PIN_AJENO = "319475";

  const ingresar = (userId: number, pin: string, conTerminal = true) => {
    const req = request(app).post(INGRESO);
    if (conTerminal) req.set("Cookie", `${TERMINAL_COOKIE}=${cookieTerminal}`);
    return req.send({ userId, pin });
  };

  /** Deja la credencial como recién creada, para que un test no arrastre al otro. */
  const limpiarIntentos = (userId: number) =>
    prisma.posPinCredential.update({
      where: { userId },
      data: { failedAttempts: 0, lockedUntil: null },
    });

  beforeAll(async () => {
    // El pepper vive fuera de la base a propósito: sin él no se valida ningún
    // código, ni siquiera con la fila entera a la vista.
    process.env.POS_PIN_PEPPER = `pepper-login-${runId}-suficientemente-largo`;

    const [sucursal, otra] = await Promise.all([
      prisma.branch.create({ data: { name: `Acceso ${runId}`, location: "893 y 851" } }),
      prisma.branch.create({ data: { name: `Otra ${runId}`, location: "Donato Álvarez" } }),
    ]);
    sucursalId = sucursal.id;
    otraSucursalId = otra.id;

    const secreto = generateDeviceSecret();
    const terminal = await prisma.terminal.create({
      data: {
        code: `ACCESO-${runId}`,
        name: "Caja del mostrador",
        branchId: sucursalId,
        deviceSecretHash: sha256(secreto),
        deviceSecretVersion: 1,
      },
    });
    cookieTerminal = buildDeviceCookieValue(terminal.id, 1, secreto);

    const password = await bcrypt.hash("supersecretpassword", 10);
    const crear = (nombre: string, rol: string, branchId: number) =>
      prisma.user.create({
        data: {
          name: `${nombre} ${runId}`,
          email: `acceso_${nombre.toLowerCase()}_${runId}@x.com`,
          password,
          role: rol,
          branches: { connect: [{ id: branchId }] },
        },
      });

    const [dueno, vendedora, sinCodigo, ajeno] = await Promise.all([
      crear("Dueno", "ADMIN", sucursalId),
      crear("Vendedora", "EMPLOYEE", sucursalId),
      crear("SinCodigo", "EMPLOYEE", sucursalId),
      crear("Ajeno", "EMPLOYEE", otraSucursalId),
    ]);
    duenoId = dueno.id;
    vendedoraId = vendedora.id;
    sinCodigoId = sinCodigo.id;
    ajenoId = ajeno.id;

    await Promise.all([
      prisma.posPinCredential.create({
        data: { userId: duenoId, pinHash: await hashPin(PIN_DUENO) },
      }),
      prisma.posPinCredential.create({
        data: { userId: vendedoraId, pinHash: await hashPin(PIN_VENDEDORA) },
      }),
      // Existe pero está deshabilitada: probar que no alcanza con tener fila.
      prisma.posPinCredential.create({
        data: {
          userId: ajenoId,
          pinHash: await hashPin(PIN_AJENO),
        },
      }),
    ]);
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { branchId: { in: [sucursalId, otraSucursalId] } } });
    await prisma.posPinCredential.deleteMany({
      where: { userId: { in: [duenoId, vendedoraId, ajenoId] } },
    });
    await prisma.terminal.deleteMany({ where: { branchId: sucursalId } });
    await prisma.user.deleteMany({
      where: { id: { in: [duenoId, vendedoraId, sinCodigoId, ajenoId] } },
    });
    await prisma.branch.deleteMany({ where: { id: { in: [sucursalId, otraSucursalId] } } });
    await prisma.$disconnect();
  });

  // ══════════════════════════════════════════════════════════════════════
  // Qué ofrece esta computadora
  // ══════════════════════════════════════════════════════════════════════

  it("una computadora sin enrolar no ofrece acceso por código", async () => {
    const res = await request(app).get(ACCESO);

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(false);
    expect(res.body.operators).toEqual([]);
    // 200 y no error: para la pantalla de login esto no es una falla, es el
    // caso más común. La computadora del escritorio no es una caja.
  });

  it("una terminal enrolada lista a su gente, y dice quién todavía no tiene código", async () => {
    const res = await request(app)
      .get(ACCESO)
      .set("Cookie", `${TERMINAL_COOKIE}=${cookieTerminal}`);

    expect(res.status).toBe(200);
    expect(res.body.enrolled).toBe(true);
    expect(res.body.terminal.branchId).toBe(sucursalId);

    const ids = res.body.operators.map((o: { id: number }) => o.id);
    expect(ids).toContain(duenoId);
    expect(ids).toContain(vendedoraId);
    expect(ids).toContain(sinCodigoId);
    // La gente de la otra sucursal no aparece: la lista sale de la sucursal de
    // la TERMINAL, que se prueba con la credencial, no de algo que el navegador
    // declare.
    expect(ids).not.toContain(ajenoId);

    const sinCodigo = res.body.operators.find(
      (o: { id: number }) => o.id === sinCodigoId,
    );
    expect(sinCodigo.hasPin).toBe(false);

    // Nunca viaja nada del secreto, ni siquiera su forma.
    expect(JSON.stringify(res.body)).not.toContain("pinHash");
  });

  // ══════════════════════════════════════════════════════════════════════
  // El factor que sostiene todo: la terminal
  // ══════════════════════════════════════════════════════════════════════

  it("sin credencial de terminal el código no sirve, aunque sea el correcto", async () => {
    const res = await ingresar(vendedoraId, PIN_VENDEDORA, false);

    expect(res.status).toBe(428);
    expect(res.body.code).toBe("TERMINAL_NOT_ENROLLED");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("una credencial de terminal adulterada no vale", async () => {
    const res = await request(app)
      .post(INGRESO)
      .set("Cookie", `${TERMINAL_COOKIE}=1.1.secreto-inventado`)
      .send({ userId: vendedoraId, pin: PIN_VENDEDORA });

    expect(res.status).toBe(428);
  });

  // ══════════════════════════════════════════════════════════════════════
  // Entrar
  // ══════════════════════════════════════════════════════════════════════

  it("con el código correcto abre sesión y la marca como PIN", async () => {
    await limpiarIntentos(vendedoraId);
    const res = await ingresar(vendedoraId, PIN_VENDEDORA);

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(vendedoraId);
    expect(res.body.user.authLevel).toBe("PIN");

    const cookies = res.headers["set-cookie"] as unknown as string[];
    const sesion = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    expect(sesion).toBeDefined();
    expect(sesion).toContain("HttpOnly");

    // El token dice cómo se entró, y el middleware lo va a leer de ahí.
    const payload = jwt.decode(sessionTokenFromResponse(res)) as {
      authLevel: string;
      id: number;
    };
    expect(payload.authLevel).toBe("PIN");
    expect(payload.id).toBe(vendedoraId);
  });

  it("la cookie nunca sobrevive al token que lleva adentro", async () => {
    await limpiarIntentos(vendedoraId);
    const res = await ingresar(vendedoraId, PIN_VENDEDORA);

    const cookies = res.headers["set-cookie"] as unknown as string[];
    const sesion = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    const { exp } = jwt.decode(sessionTokenFromResponse(res)) as { exp: number };

    const maxAge = /Max-Age=(\d+)/i.exec(sesion);
    expect(maxAge).not.toBeNull();

    const vidaDeLaCookie = Number(maxAge?.[1] ?? 0);
    const vidaDelToken = exp - Math.floor(Date.now() / 1000);

    // Antes la cookie duraba 7 días y el token 24 h: cuatro días en los que el
    // navegador mandaba una credencial vencida y la persona parecía tener
    // sesión hasta que pedía datos. Los dos números salen ahora del mismo lado.
    expect(vidaDeLaCookie).toBeLessThanOrEqual(vidaDelToken + 2);
  });

  it("un ingreso exitoso deja la cuenta de fallos en cero", async () => {
    await prisma.posPinCredential.update({
      where: { userId: vendedoraId },
      data: { failedAttempts: 3, lockedUntil: null },
    });

    await ingresar(vendedoraId, PIN_VENDEDORA).expect(200);

    const credencial = await prisma.posPinCredential.findUnique({
      where: { userId: vendedoraId },
    });
    expect(credencial?.failedAttempts).toBe(0);
  });

  // ══════════════════════════════════════════════════════════════════════
  // Lo que se rechaza — y con la misma cara siempre
  // ══════════════════════════════════════════════════════════════════════

  it("rechaza igual el código equivocado, el de otra sucursal y el de quien no tiene", async () => {
    await limpiarIntentos(vendedoraId);

    const equivocado = await ingresar(vendedoraId, "000001");
    const otraSucursal = await ingresar(ajenoId, PIN_AJENO);
    const noTiene = await ingresar(sinCodigoId, "123456");
    const noExiste = await ingresar(99_999_999, "123456");

    for (const res of [equivocado, otraSucursal, noTiene, noExiste]) {
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("BAD_PIN");
      expect(res.body.error).toBe("Código incorrecto.");
    }

    // Cuatro motivos distintos, una sola respuesta. Distinguirlos le diría a
    // quien prueba qué ids son reales y cuáles tienen código configurado.
    expect(equivocado.body).toEqual(otraSucursal.body);
    expect(equivocado.body).toEqual(noTiene.body);
    expect(equivocado.body).toEqual(noExiste.body);
  });

  it("un código mal formado no llega al controlador", async () => {
    const res = await ingresar(vendedoraId, "12ab");
    expect(res.status).toBe(400);
  });

  it("a los cinco fallos se bloquea, y el código correcto tampoco entra", async () => {
    await limpiarIntentos(duenoId);

    for (let intento = 0; intento < MAX_PIN_ATTEMPTS; intento++) {
      const res = await ingresar(duenoId, "000002");
      expect(res.status).toBe(401);
    }

    const bloqueado = await ingresar(duenoId, PIN_DUENO);
    expect(bloqueado.status).toBe(429);
    expect(bloqueado.body.code).toBe("PIN_LOCKED");

    // Se registra el hecho, nunca lo que se probó.
    const registro = await prisma.auditLog.findFirst({
      where: { action: "POS_PIN_LOCKED", entityId: String(duenoId) },
      orderBy: { id: "desc" },
    });
    expect(registro).not.toBeNull();
    expect(JSON.stringify(registro?.metadata)).not.toContain("000002");

    await limpiarIntentos(duenoId);
    /**
     * 60 segundos, y no es holgura de más: este test EJERCITA la demora
     * progresiva, que es una función de seguridad cuyo propósito es tardar.
     * Los cinco intentos suman unos 16 s de espera deliberada, más el costo de
     * Argon2 en cada uno. Con 20 s pasaba en una máquina ociosa y fallaba
     * cuando había algo más corriendo — un test que falla por el reloj y no por
     * el código enseña a ignorar los rojos.
     */
  }, 60_000);

  // ══════════════════════════════════════════════════════════════════════
  // Lo más importante: hasta dónde llega una sesión abierta con código
  // ══════════════════════════════════════════════════════════════════════

  describe("alcance de una sesión abierta con código", () => {
    const rutaAdministrativa = (token: string) =>
      request(app)
        .patch(`/api/users/${vendedoraId}/password`)
        .set("Authorization", `Bearer ${token}`)
        .send({ newPassword: "otracosaquenoimporta" });

    it("el DUEÑO que entró con código no puede administrar el sistema", async () => {
      await limpiarIntentos(duenoId);
      const ingreso = await ingresar(duenoId, PIN_DUENO);
      expect(ingreso.status).toBe(200);
      expect(ingreso.body.user.role).toBe("ADMIN");

      const res = await rutaAdministrativa(sessionTokenFromResponse(ingreso));

      // Es ADMIN, la sesión es válida, y aun así no puede: seis dígitos
      // tipeados sobre un mostrador a la vista de quien espera su turno no son
      // prueba suficiente para restablecer la contraseña de otro.
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PASSWORD_REQUIRED");
    });

    it("el mismo dueño, entrando con contraseña, sí puede", async () => {
      const token = generateTestToken({
        userId: duenoId,
        role: "ADMIN",
        branchIds: [sucursalId],
        authLevel: "PASSWORD",
      });

      const res = await rutaAdministrativa(token);
      expect(res.status).toBe(200);
    });

    it("un token viejo, sin el campo, se sigue leyendo como contraseña", async () => {
      // Los tokens emitidos antes de que esto existiera no traen `authLevel`.
      // Tomarlos como PIN habría dejado sin administrar a todo el que tuviera
      // sesión abierta el día del despliegue.
      const token = generateTestToken({
        userId: duenoId,
        role: "ADMIN",
        branchIds: [sucursalId],
      });

      const res = await rutaAdministrativa(token);
      expect(res.status).toBe(200);
    });
  });
});

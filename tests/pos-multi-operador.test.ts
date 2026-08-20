/**
 * Dos modos de trabajo del POS, y la garantía que los sostiene a los dos.
 *
 *   SESION_POR_USUARIO   cada quien en su computadora. Entrar cierra al
 *                        anterior, como funcionó siempre.
 *   TERMINAL_COMPARTIDA  una caja central con pestañas: entrar BLOQUEA al
 *                        anterior, que conserva su pestaña y su carrito.
 *
 * La garantía, en los dos modos: **nunca hay dos sesiones ACTIVAS en la misma
 * terminal**. De eso depende la atribución de cada venta, y de la atribución
 * dependen las comisiones. Un índice único parcial lo impone en la base; estos
 * tests comprueban que el código no intente violarlo.
 */
import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { hashPin } from "../src/utils/posPin.utils";
import { generateTestToken } from "./helpers/auth";
import {
  buildDeviceCookieValue,
  generateDeviceSecret,
  sha256,
  TERMINAL_COOKIE,
} from "../src/utils/terminalDevice.utils";

describe("POS: modos de operación y pestañas", () => {
  const runId = Date.now();
  let branchId = 0;
  let terminalId = 0;
  let cookieTerminal = "";
  let adminId = 0;
  let adminToken = "";
  let anaId = 0;
  let brunoId = 0;

  const PIN_ANA = "111111";
  const PIN_BRUNO = "222222";

  /** Pone el modo de trabajo, como lo haría el dueño desde Configuración. */
  const ponerModo = async (
    modo: "SESION_POR_USUARIO" | "TERMINAL_COMPARTIDA",
    exigePin = true,
  ) => {
    await prisma.appSetting.upsert({
      where: { id: 1 },
      update: { posModoOperacion: modo, posPinAlCambiarDePestana: exigePin },
      create: { id: 1, posModoOperacion: modo, posPinAlCambiarDePestana: exigePin },
    });
  };

  /** Cuántas sesiones activas hay en la terminal. Nunca puede ser más de una. */
  const activas = () =>
    prisma.posOperatorSession.count({
      where: { terminalId, status: "ACTIVE" },
    });

  const abrirSesion = (userId: number, pin: string) =>
    request(app)
      .post("/api/pos/operator-sessions")
      .set("Authorization", `Bearer ${adminToken}`)
      .set("Cookie", `${TERMINAL_COOKIE}=${cookieTerminal}`)
      .send({ userId, pin });

  beforeAll(async () => {
    // El pepper vive fuera de la base a propósito (Fase 4). Sin él no se puede
    // validar ningún PIN, así que los tests traen el suyo.
    process.env.POS_PIN_PEPPER = `pepper-multiop-${runId}-suficientemente-largo`;

    const branch = await prisma.branch.create({
      data: { name: `MultiOp ${runId}`, location: "A" },
    });
    branchId = branch.id;

    // La terminal se prueba con una credencial de dispositivo firmada, no con
    // una cabecera: un `deviceId` que el cliente declara nunca se acepta.
    const secreto = generateDeviceSecret();
    const terminal = await prisma.terminal.create({
      data: {
        code: `MULTIOP-${runId}`,
        name: "Caja central",
        branchId,
        deviceSecretHash: sha256(secreto),
        deviceSecretVersion: 1,
      },
    });
    terminalId = terminal.id;
    cookieTerminal = buildDeviceCookieValue(terminal.id, 1, secreto);

    const password = await bcrypt.hash("supersecretpassword", 10);
    const [admin, ana, bruno] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Admin MO ${runId}`,
          email: `mo_admin_${runId}@x.com`,
          password,
          role: "ADMIN",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Ana ${runId}`,
          email: `mo_ana_${runId}@x.com`,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Bruno ${runId}`,
          email: `mo_bruno_${runId}@x.com`,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
    ]);
    adminId = admin.id;
    anaId = ana.id;
    brunoId = bruno.id;

    adminToken = generateTestToken({
      userId: adminId,
      role: "ADMIN",
      branchIds: [branchId],
    });

    await Promise.all([
      prisma.posPinCredential.create({
        data: { userId: anaId, pinHash: await hashPin(PIN_ANA) },
      }),
      prisma.posPinCredential.create({
        data: { userId: brunoId, pinHash: await hashPin(PIN_BRUNO) },
      }),
    ]);
  });

  afterAll(async () => {
    await prisma.posOperatorSession.deleteMany({ where: { terminalId } });
    await prisma.posPinCredential.deleteMany({
      where: { userId: { in: [anaId, brunoId] } },
    });
    await prisma.auditLog.deleteMany({ where: { branchId } });
    await prisma.terminal.deleteMany({ where: { branchId } });
    await prisma.user.deleteMany({
      where: { id: { in: [adminId, anaId, brunoId] } },
    });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.posOperatorSession.deleteMany({ where: { terminalId } });
  });

  describe("modo SESION_POR_USUARIO (el de siempre)", () => {
    it("entrar CIERRA la sesión del anterior", async () => {
      await ponerModo("SESION_POR_USUARIO");

      await abrirSesion(anaId, PIN_ANA);
      await abrirSesion(brunoId, PIN_BRUNO);

      const deAna = await prisma.posOperatorSession.findFirst({
        where: { terminalId, userId: anaId },
      });
      // Cerrada, no bloqueada: en este modo, que entre otro significa que el
      // anterior terminó.
      expect(deAna?.status).toBe("CLOSED");
      expect(deAna?.endedAt).not.toBeNull();
      expect(await activas()).toBe(1);
    });

    it("🔒 no ofrece pestañas: volver a una sesión queda rechazado", async () => {
      await ponerModo("SESION_POR_USUARIO");
      await abrirSesion(anaId, PIN_ANA);
      const deAna = await prisma.posOperatorSession.findFirst({
        where: { terminalId, userId: anaId },
      });

      const res = await request(app)
        .post(`/api/pos/operator-sessions/${deAna!.id}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Cookie", `${TERMINAL_COOKIE}=${cookieTerminal}`)
        .send({ pin: PIN_ANA });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("MODO_NO_HABILITADO");
    });
  });

  describe("modo TERMINAL_COMPARTIDA (caja central con pestañas)", () => {
    it("entrar BLOQUEA al anterior en vez de cerrarlo", async () => {
      await ponerModo("TERMINAL_COMPARTIDA");

      await abrirSesion(anaId, PIN_ANA);
      await abrirSesion(brunoId, PIN_BRUNO);

      const deAna = await prisma.posOperatorSession.findFirst({
        where: { terminalId, userId: anaId },
      });
      // Bloqueada: Ana conserva su pestaña y su carrito esperándola.
      expect(deAna?.status).toBe("LOCKED");
      expect(deAna?.endedAt).toBeNull();
      expect(await activas()).toBe(1);
    });

    it("las dos pestañas se listan, y se ve cuál está en uso", async () => {
      await ponerModo("TERMINAL_COMPARTIDA");
      await abrirSesion(anaId, PIN_ANA);
      await abrirSesion(brunoId, PIN_BRUNO);

      const res = await request(app)
        .get("/api/pos/operator-sessions/open")
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Cookie", `${TERMINAL_COOKIE}=${cookieTerminal}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.modo).toBe("TERMINAL_COMPARTIDA");

      const activa = res.body.data.filter(
        (s: { status: string }) => s.status === "ACTIVE",
      );
      expect(activa).toHaveLength(1);
      expect(activa[0].user.id).toBe(brunoId);
    });

    it("🔒 volver a una pestaña NUNCA deja dos activas", async () => {
      await ponerModo("TERMINAL_COMPARTIDA");
      await abrirSesion(anaId, PIN_ANA);
      await abrirSesion(brunoId, PIN_BRUNO);

      const deAna = await prisma.posOperatorSession.findFirst({
        where: { terminalId, userId: anaId },
      });

      const res = await request(app)
        .post(`/api/pos/operator-sessions/${deAna!.id}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Cookie", `${TERMINAL_COOKIE}=${cookieTerminal}`)
        .send({ pin: PIN_ANA });

      expect(res.status).toBe(200);
      // Ésta es LA garantía: de ella depende a quién se le atribuye cada venta.
      expect(await activas()).toBe(1);

      const [ana, bruno] = await Promise.all([
        prisma.posOperatorSession.findFirst({ where: { terminalId, userId: anaId } }),
        prisma.posOperatorSession.findFirst({ where: { terminalId, userId: brunoId } }),
      ]);
      expect(ana?.status).toBe("ACTIVE");
      expect(bruno?.status).toBe("LOCKED");
    });

    it("🔒 con el código exigido, un PIN equivocado no abre la pestaña ajena", async () => {
      await ponerModo("TERMINAL_COMPARTIDA", true);
      await abrirSesion(anaId, PIN_ANA);
      await abrirSesion(brunoId, PIN_BRUNO);

      const deAna = await prisma.posOperatorSession.findFirst({
        where: { terminalId, userId: anaId },
      });

      const res = await request(app)
        .post(`/api/pos/operator-sessions/${deAna!.id}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Cookie", `${TERMINAL_COOKIE}=${cookieTerminal}`)
        .send({ pin: "999999" });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("BAD_PIN");
      // Y Bruno sigue siendo el que opera: nada cambió.
      const bruno = await prisma.posOperatorSession.findFirst({
        where: { terminalId, userId: brunoId },
      });
      expect(bruno?.status).toBe("ACTIVE");
    });

    it("sin código exigido, volver a la pestaña no lo pide", async () => {
      await ponerModo("TERMINAL_COMPARTIDA", false);
      await abrirSesion(anaId, PIN_ANA);
      await abrirSesion(brunoId, PIN_BRUNO);

      const deAna = await prisma.posOperatorSession.findFirst({
        where: { terminalId, userId: anaId },
      });

      const res = await request(app)
        .post(`/api/pos/operator-sessions/${deAna!.id}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Cookie", `${TERMINAL_COOKIE}=${cookieTerminal}`)
        .send({});

      expect(res.status).toBe(200);
      expect(await activas()).toBe(1);
    });

    it("🔒 una pestaña de OTRA caja no se puede activar acá", async () => {
      await ponerModo("TERMINAL_COMPARTIDA", false);
      await abrirSesion(anaId, PIN_ANA);

      // Una terminal distinta, con su propia sesión.
      const otraSucursal = await prisma.branch.create({
        data: { name: `MultiOp otra ${runId}`, location: "B" },
      });
      const otroSecreto = generateDeviceSecret();
      const otra = await prisma.terminal.create({
        data: {
          code: `MULTIOP-OTRA-${runId}`,
          name: "Otra caja",
          branchId: otraSucursal.id,
          deviceSecretHash: sha256(otroSecreto),
          deviceSecretVersion: 1,
        },
      });
      const otraTerminal = otra.id;
      const ajena = await prisma.posOperatorSession.create({
        data: {
          userId: brunoId,
          terminalId: otraTerminal,
          branchId: otraSucursal.id,
          authenticatedActorId: adminId,
          status: "LOCKED",
        },
      });

      const res = await request(app)
        .post(`/api/pos/operator-sessions/${ajena.id}/resume`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Cookie", `${TERMINAL_COOKIE}=${cookieTerminal}`)
        .send({});

      // Sin esta comprobación, mandar un id de otra caja activaría una sesión
      // ajena en esta computadora.
      expect(res.status).toBe(404);

      await prisma.posOperatorSession.deleteMany({ where: { terminalId: otraTerminal } });
      await prisma.terminal.deleteMany({ where: { branchId: otraSucursal.id } });
      await prisma.branch.delete({ where: { id: otraSucursal.id } });
    });

    it("cerrar UNA pestaña deja las demás abiertas", async () => {
      await ponerModo("TERMINAL_COMPARTIDA", false);
      await abrirSesion(anaId, PIN_ANA);
      await abrirSesion(brunoId, PIN_BRUNO);

      const deAna = await prisma.posOperatorSession.findFirst({
        where: { terminalId, userId: anaId },
      });

      const res = await request(app)
        .post(`/api/pos/operator-sessions/${deAna!.id}/close`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("Cookie", `${TERMINAL_COOKIE}=${cookieTerminal}`);

      expect(res.status).toBe(200);

      const abiertas = await prisma.posOperatorSession.findMany({
        where: { terminalId, status: { in: ["ACTIVE", "LOCKED"] } },
      });
      expect(abiertas).toHaveLength(1);
      expect(abiertas[0]?.userId).toBe(brunoId);
    });
  });
});

/**
 * Caja por rol y por sucursal.
 *
 * ── Qué se está defendiendo ─────────────────────────────────────────────────
 *
 * La caja es el único módulo donde alguien toca dinero físico, y las dos
 * preguntas que importan son "¿quién puede?" y "¿sobre qué cajón?".
 *
 * La segunda es la que se olvida: dos de los endpoints que mueven plata
 * —cerrar turno y registrar movimiento— reciben el ID del TURNO, no el de la
 * sucursal, así que el middleware de sucursal no los cubre. Si el controlador
 * no chequea, un encargado de una sucursal podría retirar efectivo del cajón de
 * la otra. Estos tests lo fijan.
 *
 * El empleado ocupa un lugar particular a propósito: PUEDE ver si la caja está
 * abierta —lo necesita para vender— y no puede abrirla, cerrarla ni mover un
 * peso.
 */

import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import { testTerminalFor } from "./helpers/terminal";

describe("Caja: permisos por rol y por sucursal", () => {
  const runId = Date.now();
  let sucursalA = 0;
  let sucursalB = 0;
  let adminId = 0;
  let encargadoAId = 0;
  let empleadoAId = 0;
  let adminToken = "";
  let encargadoAToken = "";
  let empleadoAToken = "";
  let turnoA = 0;
  let turnoB = 0;

  beforeAll(async () => {
    const a = await prisma.branch.create({
      data: { name: `Roles-A-${runId}`, location: "A", isActive: true },
    });
    const b = await prisma.branch.create({
      data: { name: `Roles-B-${runId}`, location: "B", isActive: true },
    });
    sucursalA = a.id;
    sucursalB = b.id;

    const hash = await bcrypt.hash("Password123!", 10);
    const crear = async (nombre: string, rol: string, sucursales: number[]) =>
      prisma.user.create({
        data: {
          name: `${nombre}-${runId}`,
          email: `${nombre.toLowerCase()}-${runId}@test.local`,
          password: hash,
          role: rol,
          branches: { connect: sucursales.map((id) => ({ id })) },
        },
      });

    adminId = (await crear("RolAdmin", "ADMIN", [sucursalA, sucursalB])).id;
    encargadoAId = (await crear("RolEncA", "ENCARGADO", [sucursalA])).id;
    empleadoAId = (await crear("RolEmpA", "EMPLOYEE", [sucursalA])).id;

    adminToken = generateTestToken({
      userId: adminId,
      role: "ADMIN",
      branchIds: [sucursalA, sucursalB],
    });
    encargadoAToken = generateTestToken({
      userId: encargadoAId,
      role: "ENCARGADO",
      branchIds: [sucursalA],
    });
    empleadoAToken = generateTestToken({
      userId: empleadoAId,
      role: "EMPLOYEE",
      branchIds: [sucursalA],
    });

    turnoA = (
      await prisma.cashRegister.create({
        data: {
          branchId: sucursalA,
          terminalId: await testTerminalFor(sucursalA),
          userId: adminId,
          initialBalance: 20000,
          status: "OPEN",
        },
      })
    ).id;
    turnoB = (
      await prisma.cashRegister.create({
        data: {
          branchId: sucursalB,
          terminalId: await testTerminalFor(sucursalB),
          userId: adminId,
          initialBalance: 30000,
          status: "OPEN",
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.cashMovement.deleteMany({
      where: { cashRegisterId: { in: [turnoA, turnoB] } },
    });
    await prisma.cashRegister.deleteMany({ where: { id: { in: [turnoA, turnoB] } } });
    await prisma.terminal.deleteMany({
      where: { branchId: { in: [sucursalA, sucursalB] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [adminId, encargadoAId, empleadoAId] } },
    });
    await prisma.branch.deleteMany({ where: { id: { in: [sucursalA, sucursalB] } } });
    await prisma.$disconnect();
  });

  // ── El empleado ───────────────────────────────────────────────────────────

  describe("empleado", () => {
    it("PUEDE ver si la caja está abierta: lo necesita para vender", async () => {
      const res = await request(app)
        .get(`/api/cash-registers/${sucursalA}/active`)
        .set("Authorization", `Bearer ${empleadoAToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data?.id).toBe(turnoA);
    });

    it("NO puede abrir la caja", async () => {
      const res = await request(app)
        .post("/api/cash-registers/open")
        .set("Authorization", `Bearer ${empleadoAToken}`)
        .send({ branchId: sucursalA, initialBalance: 5000 });
      expect(res.status).toBe(403);
    });

    it("NO puede cerrarla", async () => {
      const res = await request(app)
        .post(`/api/cash-registers/${turnoA}/close`)
        .set("Authorization", `Bearer ${empleadoAToken}`)
        .send({ actualBalance: 20000 });
      expect(res.status).toBe(403);
    });

    it("NO puede mover un peso del cajón", async () => {
      const res = await request(app)
        .post(`/api/cash-registers/${turnoA}/movement`)
        .set("Authorization", `Bearer ${empleadoAToken}`)
        .send({ type: "OUT", amount: 1000, reason: "Prueba" });
      expect(res.status).toBe(403);
    });

    it("NO ve el historial de turnos ni el Corte Z", async () => {
      const historial = await request(app)
        .get(`/api/cash-registers/${sucursalA}/history`)
        .set("Authorization", `Bearer ${empleadoAToken}`);
      expect(historial.status).toBe(403);

      const corte = await request(app)
        .get("/api/cash-registers/corte-z/pdf")
        .set("Authorization", `Bearer ${empleadoAToken}`);
      expect(corte.status).toBe(403);
    });
  });

  // ── El encargado, y la sucursal ajena ─────────────────────────────────────

  describe("encargado", () => {
    it("opera la caja de SU sucursal", async () => {
      const res = await request(app)
        .post(`/api/cash-registers/${turnoA}/movement`)
        .set("Authorization", `Bearer ${encargadoAToken}`)
        .send({ type: "IN", amount: 5000, reason: "Refuerzo de cambio" });
      expect(res.status).toBe(201);
    });

    it("NO puede retirar efectivo del cajón de la OTRA sucursal", async () => {
      // Éste es el que importa: el endpoint recibe el id del TURNO, no el de la
      // sucursal, así que el middleware de sucursal no lo cubre. Si el
      // controlador no chequeara, un encargado vaciaría la caja del otro local
      // desde su propia pantalla.
      const res = await request(app)
        .post(`/api/cash-registers/${turnoB}/movement`)
        .set("Authorization", `Bearer ${encargadoAToken}`)
        .send({ type: "OUT", amount: 1000, reason: "Retiro" });
      expect(res.status).toBe(403);
    });

    it("NO puede cerrar el turno de la otra sucursal", async () => {
      const res = await request(app)
        .post(`/api/cash-registers/${turnoB}/close`)
        .set("Authorization", `Bearer ${encargadoAToken}`)
        .send({ actualBalance: 30000 });
      expect(res.status).toBe(403);
    });

    it("NO ve el turno activo de la otra sucursal", async () => {
      const res = await request(app)
        .get(`/api/cash-registers/${sucursalB}/active`)
        .set("Authorization", `Bearer ${encargadoAToken}`);
      expect(res.status).toBe(403);
    });
  });

  // ── Guardas del dinero, independientes del rol ────────────────────────────

  describe("guardas del cajón", () => {
    it("no se puede retirar más de lo que hay", async () => {
      // Un retiro mayor al efectivo dejaría el esperado en negativo, y un cajón
      // con saldo negativo no existe en la realidad.
      const res = await request(app)
        .post(`/api/cash-registers/${turnoA}/movement`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ type: "OUT", amount: 9_999_999, reason: "Retiro imposible" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/en el cajón hay/u);
    });

    it("exige un motivo: un movimiento sin explicación no se puede auditar", async () => {
      const res = await request(app)
        .post(`/api/cash-registers/${turnoA}/movement`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ type: "IN", amount: 1000, reason: "" });
      expect(res.status).toBe(400);
    });

    it("rechaza montos cero o negativos", async () => {
      for (const amount of [0, -500]) {
        const res = await request(app)
          .post(`/api/cash-registers/${turnoA}/movement`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ type: "IN", amount, reason: "Monto inválido" });
        expect(res.status).toBe(400);
      }
    });

    it("rechaza un tipo de movimiento que la caja no sepa leer", async () => {
      // La contracara del bug de "INCOME": acá se corta en la puerta.
      const res = await request(app)
        .post(`/api/cash-registers/${turnoA}/movement`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ type: "INCOME", amount: 1000, reason: "Tipo inventado" });
      expect(res.status).toBe(400);
    });
  });

  // ── El admin ──────────────────────────────────────────────────────────────

  describe("admin", () => {
    it("opera cualquier sucursal", async () => {
      const res = await request(app)
        .post(`/api/cash-registers/${turnoB}/movement`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ type: "IN", amount: 2000, reason: "Ajuste del dueño" });
      expect(res.status).toBe(201);
    });

    it("el efectivo esperado refleja los movimientos ya registrados", async () => {
      // Sucursal A: 20.000 de apertura + 5.000 que metió el encargado.
      const res = await request(app)
        .get(`/api/cash-registers/${sucursalA}/active`)
        .set("Authorization", `Bearer ${adminToken}`);
      const resumen = res.body.data?.summary ?? res.body.data?.cashSummary;
      expect(resumen.expectedBalance).toBe(25000);
      // Y nada quedó sin clasificar.
      expect(resumen.unclassifiedMovements?.count ?? 0).toBe(0);
    });
  });
});

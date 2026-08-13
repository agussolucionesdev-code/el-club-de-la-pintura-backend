/**
 * Turno de caja POR TERMINAL: pasos 6 y 7 de la migración de la Fase 3.
 *
 * ── Por qué este archivo existe ─────────────────────────────────────────────
 *
 * La Fase 1 creó un índice único parcial de "un turno abierto por SUCURSAL"
 * para cerrar P0-3 cuando todavía no existía el modelo `Terminal`. La primera
 * versión del plan NO lo retiraba. Si sobrevivía, dos terminales de la misma
 * sucursal nunca habrían podido tener caja abierta a la vez — justo lo que esta
 * fase viene a habilitar. El sistema habría quedado peor que antes de empezar.
 *
 * Este test es el que detecta ese olvido: falla si el índice transitorio sigue
 * vivo, aunque todo lo demás esté bien.
 */

import request from "supertest";
import bcrypt from "bcrypt";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";

describe("Turno de caja por terminal", () => {
  const runId = Date.now();
  const email = `robot_terminal_${runId}@elclub.com`;

  let token = "";
  let userId = 0;
  let branchId = 0;
  let otraSucursalId = 0;
  let terminalAId = 0;
  let terminalBId = 0;
  let terminalAjenaId = 0;

  beforeAll(async () => {
    const [branch, otra] = await Promise.all([
      prisma.branch.create({ data: { name: `Sucursal Terminal ${runId}`, location: "A" } }),
      prisma.branch.create({ data: { name: `Sucursal Ajena ${runId}`, location: "B" } }),
    ]);
    branchId = branch.id;
    otraSucursalId = otra.id;

    const user = await prisma.user.create({
      data: {
        name: `Robot Terminal ${runId}`,
        email,
        password: await bcrypt.hash("supersecretpassword", 10),
        role: "ENCARGADO",
        branches: { connect: [{ id: branchId }, { id: otraSucursalId }] },
      },
    });
    userId = user.id;

    // Dos puestos en la MISMA sucursal — el escenario que la fase habilita.
    const [a, b, ajena] = await Promise.all([
      prisma.terminal.create({
        data: { code: `T-A-${runId}`, name: "Caja mostrador", branchId },
      }),
      prisma.terminal.create({
        data: { code: `T-B-${runId}`, name: "Caja pinturería", branchId },
      }),
      prisma.terminal.create({
        data: { code: `T-AJENA-${runId}`, name: "Caja de otra sucursal", branchId: otraSucursalId },
      }),
    ]);
    terminalAId = a.id;
    terminalBId = b.id;
    terminalAjenaId = ajena.id;

    token = generateTestToken({
      userId,
      role: "ENCARGADO",
      branchIds: [branchId, otraSucursalId],
    });
  });

  afterAll(async () => {
    await prisma.internalReceipt.deleteMany({
      where: { branchId: { in: [branchId, otraSucursalId] } },
    });
    await prisma.cashRegister.deleteMany({
      where: { branchId: { in: [branchId, otraSucursalId] } },
    });
    await prisma.terminal.deleteMany({
      where: { id: { in: [terminalAId, terminalBId, terminalAjenaId] } },
    });
    await prisma.user.deleteMany({ where: { email } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otraSucursalId] } } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.cashRegister.deleteMany({
      where: { branchId: { in: [branchId, otraSucursalId] } },
    });
  });

  const abrir = (targetBranchId: number, terminalId?: number) =>
    request(app)
      .post("/api/cash-registers/open")
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId: targetBranchId, initialBalance: 1000, ...(terminalId ? { terminalId } : {}) });

  // ── PASO 6 de la migración ───────────────────────────────────────────────

  it("dos terminales de la MISMA sucursal pueden tener su turno abierto a la vez", async () => {
    const primera = await abrir(branchId, terminalAId);
    const segunda = await abrir(branchId, terminalBId);

    expect(primera.status).toBe(201);
    // Si el índice transitorio por sucursal siguiera vivo, esto daría 400.
    expect(segunda.status).toBe(201);

    const abiertos = await prisma.cashRegister.findMany({
      where: { branchId, status: "OPEN" },
    });
    expect(abiertos).toHaveLength(2);
    expect(new Set(abiertos.map((c) => c.terminalId))).toEqual(
      new Set([terminalAId, terminalBId]),
    );
  });

  // ── PASO 7 de la migración ───────────────────────────────────────────────

  it("dos turnos en la MISMA terminal siguen rechazándose", async () => {
    expect((await abrir(branchId, terminalAId)).status).toBe(201);

    const duplicado = await abrir(branchId, terminalAId);
    expect(duplicado.status).toBe(400);
    expect(duplicado.body.error).toMatch(/turno abierto en la terminal/iu);

    const abiertos = await prisma.cashRegister.findMany({
      where: { terminalId: terminalAId, status: "OPEN" },
    });
    expect(abiertos).toHaveLength(1);
  });

  it("cinco aperturas simultáneas en la misma terminal dejan exactamente una", async () => {
    const resultados = await Promise.all(
      Array.from({ length: 5 }, () => abrir(branchId, terminalAId)),
    );

    expect(resultados.filter((r) => r.status === 201)).toHaveLength(1);
    // Perder la carrera es un caso de negocio, no un 500.
    expect(resultados.filter((r) => r.status >= 500)).toHaveLength(0);

    const abiertos = await prisma.cashRegister.findMany({
      where: { terminalId: terminalAId, status: "OPEN" },
    });
    expect(abiertos).toHaveLength(1);
  });

  // ── Cobertura heredada de la Fase 1 ──────────────────────────────────────
  // `concurrency-cash-shift.test.ts` probaba "un turno abierto por SUCURSAL",
  // regla que esta fase reemplaza. Estos dos casos eran suyos y siguen valiendo.

  it("sucursales distintas pueden tener su turno abierto a la vez", async () => {
    const [una, otra] = await Promise.all([
      abrir(branchId, terminalAId),
      abrir(otraSucursalId, terminalAjenaId),
    ]);

    expect(una.status).toBe(201);
    expect(otra.status).toBe(201);

    const abiertos = await prisma.cashRegister.findMany({
      where: { branchId: { in: [branchId, otraSucursalId] }, status: "OPEN" },
    });
    expect(abiertos).toHaveLength(2);
  });

  it("el índice sólo restringe turnos ABIERTOS: los cerrados se acumulan", async () => {
    await prisma.cashRegister.createMany({
      data: Array.from({ length: 3 }, () => ({
        initialBalance: 500,
        userId,
        branchId,
        terminalId: terminalAId,
        status: "CLOSED",
        closingTime: new Date(),
      })),
    });

    const abierto = await abrir(branchId, terminalAId);
    expect(abierto.status).toBe(201);

    const todos = await prisma.cashRegister.findMany({ where: { terminalId: terminalAId } });
    expect(todos).toHaveLength(4);
    expect(todos.filter((t) => t.status === "OPEN")).toHaveLength(1);
  });

  // ── PASO 6: CONTRACT ─────────────────────────────────────────────────────

  describe("la terminal del turno es obligatoria", () => {
    it("la columna terminalId es NOT NULL en la base", async () => {
      const [col] = await prisma.$queryRaw<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'CashRegister' AND column_name = 'terminalId'`;
      // Un turno sin terminal es un arqueo sin cajón: no se sabe de qué caja
      // salió la plata, que es el problema que esta fase vino a resolver.
      expect(col?.is_nullable).toBe("NO");
    });

    it("la base rechaza insertar un turno sin terminal", async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "CashRegister" ("initialBalance", "userId", "branchId", status, "openingTime")
          VALUES (100, ${userId}, ${branchId}, 'CLOSED', CURRENT_TIMESTAMP)`,
      ).rejects.toThrow();
    });

    it("Sale.terminalId SIGUE siendo nullable, a propósito", async () => {
      const [col] = await prisma.$queryRaw<{ is_nullable: string }[]>`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'Sale' AND column_name = 'terminalId'`;
      // Una venta puede ocurrir en una sucursal sin terminales configuradas.
      // Dejar de vender por eso sería inaceptable en un mostrador: la ausencia
      // se tolera, la incoherencia no.
      expect(col?.is_nullable).toBe("YES");
    });
  });

  // ── El índice transitorio, verificado directamente ───────────────────────

  it("el índice transitorio por sucursal YA NO existe", async () => {
    const indices = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'CashRegister'`;
    const nombres = indices.map((i) => i.indexname);

    expect(nombres).toContain("cash_register_one_open_per_terminal");
    expect(nombres).not.toContain("cash_register_one_open_per_branch_TRANSITIONAL");
  });

  // ── La terminal no se toma del cliente ───────────────────────────────────

  it("una terminal de OTRA sucursal se rechaza, no se acepta en silencio", async () => {
    const res = await abrir(branchId, terminalAjenaId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/otra sucursal/iu);
  });

  it("una terminal inexistente se rechaza", async () => {
    const res = await abrir(branchId, 999_999_999);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no existe o está desactivada/iu);
  });

  it("una terminal DESACTIVADA se rechaza", async () => {
    await prisma.terminal.update({
      where: { id: terminalBId },
      data: { status: "INACTIVE" },
    });

    const res = await abrir(branchId, terminalBId);
    expect(res.status).toBe(400);

    await prisma.terminal.update({
      where: { id: terminalBId },
      data: { status: "ACTIVE" },
    });
  });

  it("sin terminal declarada cae en la legado de la sucursal", async () => {
    // La sucursal de este test no tiene terminal LEGACY-*, porque se creó
    // después del backfill: el sistema tiene que decirlo claro en vez de
    // adivinar una terminal cualquiera.
    const res = await abrir(branchId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no tiene ninguna terminal registrada/iu);
  });

  it("el turno guarda la terminal en la que se abrió", async () => {
    const res = await abrir(branchId, terminalAId);
    expect(res.status).toBe(201);

    const turno = await prisma.cashRegister.findUniqueOrThrow({
      where: { id: res.body.data.id },
    });
    expect(turno.terminalId).toBe(terminalAId);
  });
});

/**
 * Gastos: filtros y totales, resueltos en el servidor.
 *
 * ── Qué se está defendiendo ─────────────────────────────────────────────────
 *
 * La ruta devolvía TODOS los gastos de la historia, sin rango ni tope, y la
 * pantalla filtraba en memoria. Con dos sucursales cargando gastos a diario,
 * en un año son miles de filas viajando en cada carga — y, peor, los totales y
 * los gráficos salían de lo que se alcanzaba a bajar, no de lo que hay.
 *
 * Es el mismo defecto que tenía el historial de ventas: un total que parece
 * exacto y es parcial. Estos tests fijan que el total se agregue sobre TODO el
 * rango filtrado, no sobre las filas devueltas.
 */

import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import { testTerminalFor } from "./helpers/terminal";

describe("Gastos: filtros y totales", () => {
  const runId = Date.now();
  let sucursalA = 0;
  let sucursalB = 0;
  let adminId = 0;
  let encargadoAId = 0;
  let adminToken = "";
  let encargadoAToken = "";
  let cajaA = 0;
  let cajaB = 0;

  /** Fecha ISO (YYYY-MM-DD) de hace N días, en hora local. */
  const haceDias = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  const gasto = async (opts: {
    cajaId: number;
    branchId: number;
    amount: number;
    category: string;
    diasAtras?: number;
    anulado?: boolean;
  }) => {
    const cuando = new Date();
    cuando.setDate(cuando.getDate() - (opts.diasAtras ?? 0));
    return prisma.expense.create({
      data: {
        amount: opts.amount,
        reason: `Gasto de prueba ${opts.category}`,
        category: opts.category,
        cashRegisterId: opts.cajaId,
        userId: adminId,
        branchId: opts.branchId,
        createdAt: cuando,
        ...(opts.anulado ? { voidedAt: new Date() } : {}),
      },
    });
  };

  beforeAll(async () => {
    const a = await prisma.branch.create({
      data: { name: `Gastos-A-${runId}`, location: "A", isActive: true },
    });
    const b = await prisma.branch.create({
      data: { name: `Gastos-B-${runId}`, location: "B", isActive: true },
    });
    sucursalA = a.id;
    sucursalB = b.id;

    const hash = await bcrypt.hash("Password123!", 10);
    adminId = (
      await prisma.user.create({
        data: {
          name: `GastoAdmin-${runId}`,
          email: `gasto-admin-${runId}@test.local`,
          password: hash,
          role: "ADMIN",
          branches: { connect: [{ id: sucursalA }, { id: sucursalB }] },
        },
      })
    ).id;
    encargadoAId = (
      await prisma.user.create({
        data: {
          name: `GastoEnc-${runId}`,
          email: `gasto-enc-${runId}@test.local`,
          password: hash,
          role: "ENCARGADO",
          branches: { connect: [{ id: sucursalA }] },
        },
      })
    ).id;

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

    cajaA = (
      await prisma.cashRegister.create({
        data: {
          branchId: sucursalA,
          terminalId: await testTerminalFor(sucursalA),
          userId: adminId,
          initialBalance: 100000,
          status: "OPEN",
        },
      })
    ).id;
    cajaB = (
      await prisma.cashRegister.create({
        data: {
          branchId: sucursalB,
          terminalId: await testTerminalFor(sucursalB),
          userId: adminId,
          initialBalance: 100000,
          status: "OPEN",
        },
      })
    ).id;

    // Hoy en A: 3.000 limpieza + 5.000 logística + 1.000 ANULADO
    await gasto({ cajaId: cajaA, branchId: sucursalA, amount: 3000, category: "LIMPIEZA" });
    await gasto({ cajaId: cajaA, branchId: sucursalA, amount: 5000, category: "LOGISTICA" });
    await gasto({
      cajaId: cajaA,
      branchId: sucursalA,
      amount: 1000,
      category: "LIMPIEZA",
      anulado: true,
    });
    // Hace 40 días en A: fuera del mes
    await gasto({
      cajaId: cajaA,
      branchId: sucursalA,
      amount: 90000,
      category: "ALQUILER",
      diasAtras: 40,
    });
    // Hoy en B: no lo tiene que ver el encargado de A
    await gasto({ cajaId: cajaB, branchId: sucursalB, amount: 7000, category: "LIMPIEZA" });
  });

  afterAll(async () => {
    await prisma.expense.deleteMany({
      where: { branchId: { in: [sucursalA, sucursalB] } },
    });
    await prisma.cashRegister.deleteMany({ where: { id: { in: [cajaA, cajaB] } } });
    await prisma.terminal.deleteMany({
      where: { branchId: { in: [sucursalA, sucursalB] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, encargadoAId] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [sucursalA, sucursalB] } } });
    await prisma.$disconnect();
  });

  const pedir = (token: string, qs = "") =>
    request(app).get(`/api/expenses${qs}`).set("Authorization", `Bearer ${token}`);

  it("filtra por rango de fechas en el SERVIDOR", async () => {
    const hoy = haceDias(0);
    const res = await pedir(adminToken, `?from=${hoy}&to=${hoy}&branchId=${sucursalA}`);

    expect(res.status).toBe(200);
    // El alquiler de hace 40 días no entra.
    const categorias = res.body.data.map((e: { category: string }) => e.category);
    expect(categorias).not.toContain("ALQUILER");
  });

  it("el total EXCLUYE los anulados", async () => {
    // El anulado sigue en la lista —tachado— pero no suma un peso. Si sumara,
    // anular un gasto no serviría para nada.
    const hoy = haceDias(0);
    const res = await pedir(adminToken, `?from=${hoy}&to=${hoy}&branchId=${sucursalA}`);

    expect(res.body.summary.totalAmount).toBe(8000); // 3.000 + 5.000, sin el anulado
    expect(res.body.summary.activeCount).toBe(2);
    expect(res.body.summary.totalCount).toBe(3); // el anulado sí se lista
  });

  it("el desglose por categoría sale del servidor y viene ordenado", async () => {
    const hoy = haceDias(0);
    const res = await pedir(adminToken, `?from=${hoy}&to=${hoy}&branchId=${sucursalA}`);

    const cats = res.body.summary.byCategory;
    expect(cats[0]).toMatchObject({ category: "LOGISTICA", amount: 5000, count: 1 });
    expect(cats[1]).toMatchObject({ category: "LIMPIEZA", amount: 3000, count: 1 });
    // De mayor a menor: la categoría que más duele va primero.
    expect(cats.map((c: { amount: number }) => c.amount)).toEqual(
      [...cats.map((c: { amount: number }) => c.amount)].sort((x, y) => y - x),
    );
  });

  it("filtra por categoría", async () => {
    const res = await pedir(adminToken, `?category=LOGISTICA&branchId=${sucursalA}`);
    expect(res.body.summary.totalAmount).toBe(5000);
    expect(
      res.body.data.every((e: { category: string }) => e.category === "LOGISTICA"),
    ).toBe(true);
  });

  it("un rango amplio SÍ trae el gasto viejo, y el total lo refleja", async () => {
    const res = await pedir(
      adminToken,
      `?from=${haceDias(60)}&to=${haceDias(0)}&branchId=${sucursalA}`,
    );
    // 3.000 + 5.000 + 90.000, sin el anulado.
    expect(res.body.summary.totalAmount).toBe(98000);
  });

  it("el encargado NO ve los gastos de la otra sucursal", async () => {
    const res = await pedir(encargadoAToken);
    const sucursales = new Set(res.body.data.map((e: { branchId: number }) => e.branchId));
    expect(sucursales.has(sucursalB)).toBe(false);
  });

  it("pedir la sucursal ajena devuelve lo propio, no un error", async () => {
    // Preguntar no es una ofensa: se devuelve menos, no un portazo.
    const res = await pedir(encargadoAToken, `?branchId=${sucursalB}`);
    expect(res.status).toBe(200);
    const sucursales = new Set(res.body.data.map((e: { branchId: number }) => e.branchId));
    expect(sucursales.has(sucursalB)).toBe(false);
  });

  it("avisa cuando la lista viene recortada", async () => {
    const res = await pedir(adminToken, `?branchId=${sucursalA}`);
    // Con 4 gastos no se recorta nada; lo que importa es que el campo exista y
    // sea honesto, para que la pantalla pueda decir "hay más".
    expect(res.body.summary).toHaveProperty("truncated");
    expect(res.body.summary.truncated).toBe(false);
  });
});

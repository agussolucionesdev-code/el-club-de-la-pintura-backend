/**
 * Disponibilidad de un producto, sucursal por sucursal.
 *
 * ── Qué se defiende ─────────────────────────────────────────────────────────
 *
 * La pregunta del mostrador es "acá no hay, ¿hay en la otra?". El endpoint que
 * ya existía respondía otra cosa: la SUMA de todas las sucursales. Con eso el
 * cajero sabe que en algún lado hay cinco, y no sabe a dónde mandar al cliente.
 *
 * Y la autorización era por rol, así que el empleado con
 * `stock:view_all_branches` —la capacidad que existe justamente para esto—
 * quedaba filtrado a lo suyo y la capacidad no hacía nada.
 */

import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";

describe("GET /stock/availability/:productId", () => {
  const runId = Date.now();
  let sucursalA = 0;
  let sucursalB = 0;
  let sucursalInactiva = 0;
  let productId = 0;
  let adminId = 0;
  let empleadoId = 0;
  let adminToken = "";
  let empleadoToken = "";

  beforeAll(async () => {
    const a = await prisma.branch.create({
      data: { name: `Disp-A-${runId}`, location: "893 y 851", isActive: true },
    });
    const b = await prisma.branch.create({
      data: { name: `Disp-B-${runId}`, location: "Donato Álvarez", isActive: true },
    });
    const inactiva = await prisma.branch.create({
      data: { name: `Disp-X-${runId}`, location: "Cerrada", isActive: false },
    });
    sucursalA = a.id;
    sucursalB = b.id;
    sucursalInactiva = inactiva.id;

    const hash = await bcrypt.hash("Password123!", 10);
    const admin = await prisma.user.create({
      data: {
        name: `DispAdmin-${runId}`,
        email: `disp-admin-${runId}@test.local`,
        password: hash,
        role: "ADMIN",
        branches: { connect: [{ id: sucursalA }, { id: sucursalB }] },
      },
    });
    adminId = admin.id;

    // El empleado pertenece SÓLO a la sucursal A. Su rol tiene
    // `stock:view_all_branches`, así que igual tiene que ver la B.
    const empleado = await prisma.user.create({
      data: {
        name: `DispEmp-${runId}`,
        email: `disp-emp-${runId}@test.local`,
        password: hash,
        role: "EMPLOYEE",
        branches: { connect: [{ id: sucursalA }] },
      },
    });
    empleadoId = empleado.id;

    adminToken = generateTestToken({
      userId: adminId,
      role: "ADMIN",
      branchIds: [sucursalA, sucursalB],
    });
    empleadoToken = generateTestToken({
      userId: empleadoId,
      role: "EMPLOYEE",
      branchIds: [sucursalA],
    });

    const producto = await prisma.product.create({
      data: {
        sku: `DISP-${runId}`,
        name: `Látex 20L ${runId}`,
        brand: "Robot",
        category: "Pinturas",
        retailPrice: 85000,
        costPrice: 51000,
      },
    });
    productId = producto.id;

    await prisma.stock.createMany({
      data: [
        { productId, branchId: sucursalA, quantity: 0, minStock: 5, criticalStock: 2 },
        { productId, branchId: sucursalB, quantity: 7, minStock: 5, criticalStock: 2 },
        { productId, branchId: sucursalInactiva, quantity: 99, minStock: 5, criticalStock: 2 },
      ],
    });
  });

  afterAll(async () => {
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, empleadoId] } } });
    await prisma.branch.deleteMany({
      where: { id: { in: [sucursalA, sucursalB, sucursalInactiva] } },
    });
    await prisma.$disconnect();
  });

  it("devuelve el DESGLOSE por sucursal, no una suma", async () => {
    // Éste es el punto. "Entre las dos hay 7" no le sirve al cajero: necesita
    // saber que las 7 están en Donato Álvarez.
    const res = await request(app)
      .get(`/api/stock/availability/${productId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    const sucursales = res.body.data.branches as { branchId: number; quantity: number }[];
    const porId = new Map(sucursales.map((s) => [s.branchId, s.quantity]));
    expect(porId.get(sucursalA)).toBe(0);
    expect(porId.get(sucursalB)).toBe(7);
  });

  it("ordena por cantidad: dónde ir primero se lee sin pensar", async () => {
    const res = await request(app)
      .get(`/api/stock/availability/${productId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    const cantidades = (res.body.data.branches as { quantity: number }[]).map(
      (s) => s.quantity,
    );
    expect(cantidades).toEqual([...cantidades].sort((x, y) => y - x));
  });

  it("un empleado de OTRA sucursal ve dónde hay, por capacidad y no por rol", async () => {
    // El empleado pertenece sólo a la sucursal A, y A tiene cero. Sin esto,
    // mandaría al cliente a la casa por un producto que sí está en stock.
    const res = await request(app)
      .get(`/api/stock/availability/${productId}`)
      .set("Authorization", `Bearer ${empleadoToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.showsAllBranches).toBe(true);
    const ids = (res.body.data.branches as { branchId: number }[]).map((s) => s.branchId);
    expect(ids).toContain(sucursalB);
  });

  it("NUNCA devuelve costos", async () => {
    // Ver dónde hay mercadería es información de mostrador. El costo tiene su
    // propia capacidad y no viaja acá ni para el dueño.
    const res = await request(app)
      .get(`/api/stock/availability/${productId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    const crudo = JSON.stringify(res.body);
    expect(crudo).not.toContain("costPrice");
    expect(crudo).not.toContain("51000");
  });

  it("ignora las sucursales dadas de baja", async () => {
    // La inactiva tiene 99 unidades. Mandar a alguien a un local cerrado es
    // peor que decirle que no hay.
    const res = await request(app)
      .get(`/api/stock/availability/${productId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    const ids = (res.body.data.branches as { branchId: number }[]).map((s) => s.branchId);
    expect(ids).not.toContain(sucursalInactiva);
    expect(res.body.data.total).toBe(7);
  });

  it("un producto que no existe da 404, no una lista vacía", async () => {
    const res = await request(app)
      .get("/api/stock/availability/99999999")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(404);
  });

  it("rechaza un id que no es un número", async () => {
    const res = await request(app)
      .get("/api/stock/availability/abc")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(400);
  });

  it("sin sesión no se responde nada", async () => {
    const res = await request(app).get(`/api/stock/availability/${productId}`);
    expect([401, 403]).toContain(res.status);
  });
});

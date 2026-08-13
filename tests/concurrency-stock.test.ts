/**
 * Concurrencia sobre el stock: dos cajas peleando por la última unidad.
 *
 * Antes del descuento atómico, este escenario **vendía dos veces la misma
 * unidad**: ambas transacciones leían `quantity = 1`, ambas pasaban la
 * validación en JavaScript, y ambas escribían el valor precalculado `0`.
 *
 * Los tests disparan requests reales en paralelo con `Promise.all` contra la
 * base de tests. No simulan la carrera: la provocan.
 */

import request from "supertest";
import bcrypt from "bcrypt";

import app from "../src/app";
import prisma from "../src/config/db";
import { testTerminalFor } from "./helpers/terminal";
import { generateTestToken } from "./helpers/auth";

describe("Concurrencia de stock: la última unidad no se vende dos veces", () => {
  const runId = Date.now();
  const email = `robot_concurrencia_${runId}@elclub.com`;

  let token = "";
  let userId = 0;
  let branchId = 0;
  let otherBranchId = 0;
  let cashRegisterId = 0;
  let productId = 0;

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `Sucursal Concurrencia ${runId}`, location: "Mostrador" },
    });
    branchId = branch.id;

    const otherBranch = await prisma.branch.create({
      data: { name: `Sucursal Destino ${runId}`, location: "Depósito" },
    });
    otherBranchId = otherBranch.id;

    const user = await prisma.user.create({
      data: {
        name: `Robot Concurrencia ${runId}`,
        email,
        password: await bcrypt.hash("supersecretpassword", 10),
        role: "ENCARGADO",
        branches: { connect: [{ id: branchId }, { id: otherBranchId }] },
      },
    });
    userId = user.id;

    const product = await prisma.product.create({
      data: {
        sku: `CONC-${runId}`,
        name: `Producto Concurrencia ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        costPrice: 100,
        retailPrice: 500,
      },
    });
    productId = product.id;

    const cashRegister = await prisma.cashRegister.create({
      data: { terminalId: await testTerminalFor(branchId), initialBalance: 100, status: "OPEN", userId, branchId },
    });
    cashRegisterId = cashRegister.id;

    token = generateTestToken({ userId, role: "ENCARGADO", branchIds: [branchId, otherBranchId] });
  });

  afterAll(async () => {
    const sales = await prisma.sale.findMany({ where: { branchId }, select: { id: true } });
    const saleIds = sales.map((sale) => sale.id);

    await prisma.internalReceipt.deleteMany({ where: { branchId: { in: [branchId, otherBranchId] } } });
    await prisma.payment.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    await prisma.movement.deleteMany({ where: { productId } });
    await prisma.stockTransfer.deleteMany({ where: { productId } });
    await prisma.cashRegister.deleteMany({ where: { id: cashRegisterId } });
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { email } });
    // El helper crea una terminal por sucursal; hay que borrarla ANTES
    // que la sucursal o la clave foránea lo impide.
    await prisma.terminal.deleteMany({ where: { code: { startsWith: "TEST-" } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otherBranchId] } } });
    await prisma.$disconnect();
  });

  /** Deja el stock de la sucursal principal en un valor exacto. */
  const setStock = async (quantity: number) => {
    await prisma.stock.upsert({
      where: { productId_branchId: { productId, branchId } },
      update: { quantity },
      create: { productId, branchId, quantity, minStock: 0 },
    });
  };

  const sellOneUnit = () =>
    request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${token}`)
      .send({
        branchId,
        cashRegisterId,
        paymentMethod: "CASH",
        totalAmount: 500,
        items: [{ productId, quantity: 1, unitPrice: 500, subtotal: 500 }],
      });

  it("con 1 unidad y dos ventas simultáneas: una vende, la otra falla, el stock queda en 0", async () => {
    await setStock(1);

    const [first, second] = await Promise.all([sellOneUnit(), sellOneUnit()]);
    const statuses = [first.status, second.status].sort();

    // Exactamente una vendió. La otra fue rechazada, no encolada ni aceptada.
    expect(statuses).toEqual([201, 400]);

    const rejected = first.status === 400 ? first : second;
    expect(rejected.body.error).toMatch(/[Ss]tock insuficiente/u);

    const stock = await prisma.stock.findUniqueOrThrow({
      where: { productId_branchId: { productId, branchId } },
    });

    // Lo importante: 0, y nunca negativo. Antes del arreglo quedaba en 0 pero
    // con DOS ventas registradas — o sea, una unidad vendida dos veces.
    expect(stock.quantity).toBe(0);

    const soldUnits = await prisma.saleItem.aggregate({
      where: { productId },
      _sum: { quantity: true },
    });
    expect(soldUnits._sum.quantity).toBe(1);
  });

  it("con 3 unidades y cinco ventas simultáneas: venden exactamente 3", async () => {
    await prisma.saleItem.deleteMany({ where: { productId } });
    await setStock(3);

    const results = await Promise.all(Array.from({ length: 5 }, () => sellOneUnit()));
    const created = results.filter((res) => res.status === 201);
    const rejected = results.filter((res) => res.status === 400);

    expect(created).toHaveLength(3);
    expect(rejected).toHaveLength(2);

    const stock = await prisma.stock.findUniqueOrThrow({
      where: { productId_branchId: { productId, branchId } },
    });
    expect(stock.quantity).toBe(0);

    const soldUnits = await prisma.saleItem.aggregate({
      where: { productId },
      _sum: { quantity: true },
    });
    expect(soldUnits._sum.quantity).toBe(3);
  });

  it("el stock nunca queda negativo aunque se pidan más unidades de las que hay", async () => {
    await prisma.saleItem.deleteMany({ where: { productId } });
    await setStock(2);

    const bigSale = await request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${token}`)
      .send({
        branchId,
        cashRegisterId,
        paymentMethod: "CASH",
        totalAmount: 2500,
        items: [{ productId, quantity: 5, unitPrice: 500, subtotal: 2500 }],
      });

    expect(bigSale.status).toBe(400);

    const stock = await prisma.stock.findUniqueOrThrow({
      where: { productId_branchId: { productId, branchId } },
    });
    // Rechazada entera: el stock no se tocó.
    expect(stock.quantity).toBe(2);
  });

  it("una cantidad fraccionaria se rechaza como cantidad inválida, no como falta de stock", async () => {
    await prisma.saleItem.deleteMany({ where: { productId } });
    await setStock(100);

    const res = await request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${token}`)
      .send({
        branchId,
        cashRegisterId,
        paymentMethod: "CASH",
        totalAmount: 1250,
        items: [{ productId, quantity: 2.5, unitPrice: 500, subtotal: 1250 }],
      });

    expect(res.status).toBe(400);
    // Desde la Fase 2 el schema la frena ANTES de llegar al stock, que es mejor
    // todavía: se rechaza en el borde. Lo que importa sigue siendo que no se
    // confunda con falta de stock — mandar a contar unidades a alguien cuyo
    // error es una cantidad fraccionaria lo hace perder el tiempo al pedo.
    const mensaje = JSON.stringify(res.body);
    expect(mensaje).toMatch(/entero|[Cc]antidad inválida/u);
    expect(mensaje).not.toMatch(/[Ss]tock insuficiente/u);

    const stock = await prisma.stock.findUniqueOrThrow({
      where: { productId_branchId: { productId, branchId } },
    });
    expect(stock.quantity).toBe(100); // intacto
  });

  it("dos transferencias simultáneas no mueven más stock del que existe", async () => {
    await prisma.saleItem.deleteMany({ where: { productId } });
    await setStock(1);
    await prisma.stock.deleteMany({ where: { productId, branchId: otherBranchId } });

    const transfer = () =>
      request(app)
        .post("/api/stock/transfers")
        .set("Authorization", `Bearer ${token}`)
        .send({
          productId,
          fromBranchId: branchId,
          toBranchId: otherBranchId,
          quantity: 1,
          reason: "Prueba de concurrencia",
        });

    const results = await Promise.all([transfer(), transfer()]);
    const ok = results.filter((res) => res.status >= 200 && res.status < 300);

    expect(ok).toHaveLength(1);

    const [source, target] = await Promise.all([
      prisma.stock.findUniqueOrThrow({
        where: { productId_branchId: { productId, branchId } },
      }),
      prisma.stock.findUniqueOrThrow({
        where: { productId_branchId: { productId, branchId: otherBranchId } },
      }),
    ]);

    // Conservación: lo que salió de una sucursal entró en la otra, ni más ni menos.
    expect(source.quantity).toBe(0);
    expect(target.quantity).toBe(1);
  });
});

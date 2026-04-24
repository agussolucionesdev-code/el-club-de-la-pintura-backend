import request from "supertest";
import bcrypt from "bcrypt";
import { IncomingMessage } from "http";
import app from "../src/app";
import prisma from "../src/config/db";

const parseBinaryResponse = (
  response: IncomingMessage,
  callback: (error: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];

  response.on("data", (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  response.on("end", () => callback(null, Buffer.concat(chunks)));
};

describe("Dashboard ERP por sucursal", () => {
  const runId = Date.now();
  const managerCreds = {
    email: `robot_dashboard_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let managerToken = "";
  let managerId = 0;
  let branchAId = 0;
  let branchBId = 0;
  let productId = 0;
  let customerId = 0;
  let cashRegisterId = 0;
  let saleId = 0;

  beforeAll(async () => {
    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({
        data: { name: `Dashboard Norte ${runId}`, location: "Zona A" },
      }),
      prisma.branch.create({
        data: { name: `Dashboard Sur ${runId}`, location: "Zona B" },
      }),
    ]);

    branchAId = branchA.id;
    branchBId = branchB.id;

    const hashedPassword = await bcrypt.hash(managerCreds.password, 10);
    const manager = await prisma.user.create({
      data: {
        name: `Robot Dashboard ${runId}`,
        email: managerCreds.email,
        password: hashedPassword,
        role: "ENCARGADO",
        branches: { connect: [{ id: branchAId }] },
      },
    });
    managerId = manager.id;

    const product = await prisma.product.create({
      data: {
        sku: `DASH-${runId}`,
        name: `Producto Dashboard ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        costPrice: 80,
        retailPrice: 120,
      },
    });
    productId = product.id;

    const customer = await prisma.customer.create({
      data: { name: `Cliente Dashboard ${runId}` },
    });
    customerId = customer.id;

    const cashRegister = await prisma.cashRegister.create({
      data: {
        initialBalance: 1000,
        status: "OPEN",
        userId: managerId,
        branchId: branchAId,
      },
    });
    cashRegisterId = cashRegister.id;

    await prisma.stock.create({
      data: {
        productId,
        branchId: branchAId,
        quantity: 1,
        minStock: 5,
        criticalStock: 2,
      },
    });

    const sale = await prisma.sale.create({
      data: {
        totalAmount: 240,
        paymentMethod: "CASH",
        status: "PARTIAL",
        balance: 40,
        customerId,
        branchId: branchAId,
        userId: managerId,
        cashRegisterId,
        items: {
          create: [
            {
              productId,
              quantity: 2,
              unitPrice: 120,
              subtotal: 240,
              unitCost: 80,
            },
          ],
        },
      },
    });
    saleId = sale.id;

    await prisma.payment.create({
      data: {
        amount: 200,
        paymentMethod: "CASH",
        saleId,
        userId: managerId,
        branchId: branchAId,
        cashRegisterId,
      },
    });

    await prisma.expense.create({
      data: {
        amount: 25,
        reason: "Insumos de prueba",
        category: "insumos",
        type: "VARIABLE",
        cashRegisterId,
        userId: managerId,
        branchId: branchAId,
      },
    });

    const loginResponse = await request(app)
      .post("/api/users/login")
      .send(managerCreds);

    managerToken = loginResponse.body.token;
  });

  afterAll(async () => {
    await prisma.expense.deleteMany({ where: { branchId: branchAId } });
    await prisma.payment.deleteMany({ where: { saleId } });
    await prisma.saleItem.deleteMany({ where: { saleId } });
    await prisma.sale.deleteMany({ where: { id: saleId } });
    await prisma.cashRegister.deleteMany({ where: { id: cashRegisterId } });
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.user.deleteMany({ where: { email: managerCreds.email } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchAId, branchBId] } } });
    await prisma.$disconnect();
  });

  it("devuelve KPIs, breakdowns y alertas reales para la sucursal asignada", async () => {
    const response = await request(app)
      .get(`/api/dashboard/summary?branchId=${branchAId}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(200);
    expect(response.body.kpis).toMatchObject({
      totalBilled: 240,
      totalCollected: 200,
      totalDebt: 40,
      totalExpenses: 25,
      grossProfit: 80,
      netProfit: 55,
      stockAlerts: 1,
      criticalStockAlerts: 1,
      salesCount: 1,
      openCashRegisters: 1,
    });
    expect(response.body.paymentBreakdown.CASH).toBe(200);
    expect(response.body.expenseBreakdown.INSUMOS).toBe(25);
    expect(response.body.topProducts[0]).toMatchObject({
      productId,
      units: 2,
      revenue: 240,
      estimatedCost: 160,
    });
    expect(response.body.recentSales[0]).toMatchObject({
      id: saleId,
      totalAmount: 240,
      balance: 40,
    });
    expect(response.body.inventoryHealth.critical[0]).toMatchObject({
      productId,
      branchId: branchAId,
      quantity: 1,
    });
  });

  it("bloquea dashboard de una sucursal no asignada al encargado", async () => {
    const response = await request(app)
      .get(`/api/dashboard/summary?branchId=${branchBId}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(403);
  });

  it("bloquea dashboard consolidado para encargados", async () => {
    const response = await request(app)
      .get("/api/dashboard/summary?branchId=0")
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(403);
  });

  it("exporta Excel filtrado con resumen, ventas, cobranzas y gastos", async () => {
    const response = await request(app)
      .get(`/api/dashboard/export?branchId=${branchAId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .buffer(true)
      .parse(parseBinaryResponse as never);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(response.headers["content-disposition"]).toContain(
      "Reporte_Contable_ElClub",
    );

    const body = Buffer.from(response.body as Uint8Array);
    expect(body.length).toBeGreaterThan(1000);
    expect(body.subarray(0, 2).toString()).toBe("PK");
  });

  it("bloquea exportacion Excel de una sucursal no asignada al encargado", async () => {
    const response = await request(app)
      .get(`/api/dashboard/export?branchId=${branchBId}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(403);
  });

  it("bloquea exportacion Excel consolidada para encargados", async () => {
    const response = await request(app)
      .get("/api/dashboard/export?branchId=0")
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(403);
  });
});

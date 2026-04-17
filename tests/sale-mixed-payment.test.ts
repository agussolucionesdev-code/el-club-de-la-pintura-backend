import request from "supertest";
import bcrypt from "bcrypt";
import app from "../src/app";
import prisma from "../src/config/db";

describe("POS ERP: ventas con pagos multiples", () => {
  const runId = Date.now();
  const operatorCreds = {
    email: `robot_mixed_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let operatorToken = "";
  let operatorId = 0;
  let branchId = 0;
  let cashRegisterId = 0;
  let productId = 0;
  let saleId = 0;

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `Sucursal Mixta ${runId}`, location: "Caja POS" },
    });
    branchId = branch.id;

    const hashedPassword = await bcrypt.hash(operatorCreds.password, 10);
    const operator = await prisma.user.create({
      data: {
        name: `Robot Mixto ${runId}`,
        email: operatorCreds.email,
        password: hashedPassword,
        role: "ENCARGADO",
        branches: { connect: [{ id: branchId }] },
      },
    });
    operatorId = operator.id;

    const product = await prisma.product.create({
      data: {
        sku: `MIX-${runId}`,
        name: `Producto Mixto ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        costPrice: 100,
        retailPrice: 500,
      },
    });
    productId = product.id;

    await prisma.stock.create({
      data: { productId, branchId, quantity: 10, minStock: 2 },
    });

    const cashRegister = await prisma.cashRegister.create({
      data: {
        initialBalance: 100,
        status: "OPEN",
        userId: operatorId,
        branchId,
      },
    });
    cashRegisterId = cashRegister.id;

    const loginResponse = await request(app)
      .post("/api/users/login")
      .send(operatorCreds);

    operatorToken = loginResponse.body.token;
  });

  afterAll(async () => {
    await prisma.internalReceipt.deleteMany({ where: { saleId } });
    await prisma.payment.deleteMany({ where: { saleId } });
    await prisma.movement.deleteMany({ where: { productId } });
    await prisma.saleItem.deleteMany({ where: { saleId } });
    await prisma.sale.deleteMany({ where: { id: saleId } });
    await prisma.cashRegister.deleteMany({ where: { id: cashRegisterId } });
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { email: operatorCreds.email } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  it("registra varios medios de pago y solo suma efectivo al arqueo", async () => {
    const saleResponse = await request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        branchId,
        cashRegisterId,
        paymentMethod: "MIXED",
        totalAmount: 500,
        payments: [
          { paymentMethod: "CASH", amount: 300 },
          { paymentMethod: "DEBIT", amount: 200 },
        ],
        items: [
          {
            productId,
            quantity: 1,
            unitPrice: 500,
            subtotal: 500,
          },
        ],
      });

    expect(saleResponse.status).toBe(201);
    expect(saleResponse.body.message).toContain("pagos multiples");
    expect(saleResponse.body.data).toMatchObject({
      paymentMethod: "MIXED",
      status: "PAID",
      balance: 0,
    });
    expect(saleResponse.body.receipt.paymentId).toBeNull();
    expect(saleResponse.body.receipt.payload).toMatchObject({
      paymentMethod: "MIXED",
      paymentsCount: 2,
      payments: [
        { paymentMethod: "CASH", amount: 300 },
        { paymentMethod: "DEBIT", amount: 200 },
      ],
    });

    saleId = saleResponse.body.data.id;

    const payments = await prisma.payment.findMany({
      where: { saleId },
      orderBy: { amount: "desc" },
    });
    expect(payments).toHaveLength(2);
    expect(payments.map((payment) => payment.paymentMethod).sort()).toEqual([
      "CASH",
      "DEBIT",
    ]);

    const activeCashResponse = await request(app)
      .get(`/api/cash-registers/${branchId}/active`)
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(activeCashResponse.status).toBe(200);
    expect(activeCashResponse.body.data.cashSummary).toMatchObject({
      totalCashPayments: 300,
      totalNonCashPayments: 200,
      expectedBalance: 400,
    });
  });

  it("rechaza pagos multiples cuando no cubren el total exacto", async () => {
    const saleResponse = await request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        branchId,
        cashRegisterId,
        paymentMethod: "MIXED",
        totalAmount: 500,
        payments: [
          { paymentMethod: "CASH", amount: 300 },
          { paymentMethod: "DEBIT", amount: 100 },
        ],
        items: [
          {
            productId,
            quantity: 1,
            unitPrice: 500,
            subtotal: 500,
          },
        ],
      });

    expect(saleResponse.status).toBe(400);
    expect(saleResponse.body.error).toContain("suma de los pagos");
  });
});

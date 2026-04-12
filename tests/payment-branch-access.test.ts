import request from "supertest";
import bcrypt from "bcrypt";
import app from "../src/app";
import prisma from "../src/config/db";

describe("Cobranzas de cuenta corriente por sucursal", () => {
  const runId = Date.now();
  const managerCreds = {
    email: `robot_payments_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let managerToken = "";
  let managerId = 0;
  let branchAId = 0;
  let branchBId = 0;
  let customerAId = 0;
  let customerBId = 0;
  let cashRegisterAId = 0;
  let cashRegisterBId = 0;
  let saleAId = 0;
  let saleBId = 0;

  beforeAll(async () => {
    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({
        data: { name: `Payments Norte ${runId}`, location: "Zona A" },
      }),
      prisma.branch.create({
        data: { name: `Payments Sur ${runId}`, location: "Zona B" },
      }),
    ]);

    branchAId = branchA.id;
    branchBId = branchB.id;

    const hashedPassword = await bcrypt.hash(managerCreds.password, 10);
    const manager = await prisma.user.create({
      data: {
        name: `Robot Payments ${runId}`,
        email: managerCreds.email,
        password: hashedPassword,
        role: "ENCARGADO",
        branches: { connect: [{ id: branchAId }] },
      },
    });
    managerId = manager.id;

    const [customerA, customerB] = await Promise.all([
      prisma.customer.create({
        data: { name: `Cliente Payments Norte ${runId}` },
      }),
      prisma.customer.create({
        data: { name: `Cliente Payments Sur ${runId}` },
      }),
    ]);
    customerAId = customerA.id;
    customerBId = customerB.id;

    const [cashRegisterA, cashRegisterB] = await Promise.all([
      prisma.cashRegister.create({
        data: {
          initialBalance: 500,
          status: "OPEN",
          userId: managerId,
          branchId: branchAId,
        },
      }),
      prisma.cashRegister.create({
        data: {
          initialBalance: 500,
          status: "OPEN",
          userId: managerId,
          branchId: branchBId,
        },
      }),
    ]);
    cashRegisterAId = cashRegisterA.id;
    cashRegisterBId = cashRegisterB.id;

    const [saleA, saleB] = await Promise.all([
      prisma.sale.create({
        data: {
          totalAmount: 100,
          paymentMethod: "CREDIT_ACCOUNT",
          status: "PENDING",
          balance: 100,
          pickedUpBy: "Robot Norte",
          customerId: customerAId,
          branchId: branchAId,
          userId: managerId,
          cashRegisterId: cashRegisterAId,
        },
      }),
      prisma.sale.create({
        data: {
          totalAmount: 150,
          paymentMethod: "CREDIT_ACCOUNT",
          status: "PENDING",
          balance: 150,
          pickedUpBy: "Robot Sur",
          customerId: customerBId,
          branchId: branchBId,
          userId: managerId,
          cashRegisterId: cashRegisterBId,
        },
      }),
    ]);
    saleAId = saleA.id;
    saleBId = saleB.id;

    const loginResponse = await request(app)
      .post("/api/users/login")
      .send(managerCreds);

    managerToken = loginResponse.body.token;
  });

  afterAll(async () => {
    await prisma.internalReceipt.deleteMany({
      where: { saleId: { in: [saleAId, saleBId] } },
    });
    await prisma.payment.deleteMany({
      where: { saleId: { in: [saleAId, saleBId] } },
    });
    await prisma.sale.deleteMany({ where: { id: { in: [saleAId, saleBId] } } });
    await prisma.cashRegister.deleteMany({
      where: { id: { in: [cashRegisterAId, cashRegisterBId] } },
    });
    await prisma.customer.deleteMany({
      where: { id: { in: [customerAId, customerBId] } },
    });
    await prisma.user.deleteMany({ where: { email: managerCreds.email } });
    await prisma.branch.deleteMany({
      where: { id: { in: [branchAId, branchBId] } },
    });
    await prisma.$disconnect();
  });

  it("registra un pago sin branchId en el body y usa la sucursal de la cuenta", async () => {
    const response = await request(app)
      .post("/api/payments/account")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        saleId: saleAId,
        amount: 40,
        paymentMethod: "cash",
        cashRegisterId: cashRegisterAId,
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      newBalance: 60,
      status: "PARTIAL",
      payment: {
        amount: 40,
        paymentMethod: "CASH",
        saleId: saleAId,
        branchId: branchAId,
        cashRegisterId: cashRegisterAId,
      },
      receipt: {
        receiptType: "PAYMENT",
        branchId: branchAId,
        saleId: saleAId,
      },
    });
  });

  it("rechaza sobrepagos y preserva el saldo pendiente", async () => {
    const response = await request(app)
      .post("/api/payments/account")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        saleId: saleAId,
        amount: 61,
        paymentMethod: "CASH",
        cashRegisterId: cashRegisterAId,
      });

    expect(response.status).toBe(400);

    const sale = await prisma.sale.findUnique({ where: { id: saleAId } });
    expect(sale?.balance).toBe(60);
    expect(sale?.status).toBe("PARTIAL");
  });

  it("bloquea cobros de cuentas de una sucursal no asignada", async () => {
    const response = await request(app)
      .post("/api/payments/account")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        saleId: saleBId,
        amount: 10,
        paymentMethod: "CASH",
        cashRegisterId: cashRegisterAId,
      });

    expect(response.status).toBe(403);
  });

  it("bloquea cajas abiertas en una sucursal no asignada", async () => {
    const response = await request(app)
      .post("/api/payments/account")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        saleId: saleBId,
        amount: 10,
        paymentMethod: "TRANSFER",
        cashRegisterId: cashRegisterBId,
      });

    expect(response.status).toBe(403);
  });
});

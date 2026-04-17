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

describe("Anulacion operativa de ventas", () => {
  const runId = Date.now();
  const managerCreds = {
    email: `robot_cancel_manager_${runId}@elclub.com`,
    password: "supersecretpassword",
  };
  const employeeCreds = {
    email: `robot_cancel_employee_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let managerToken = "";
  let employeeToken = "";
  let managerId = 0;
  let employeeId = 0;
  let branchAId = 0;
  let branchBId = 0;
  let customerId = 0;
  let cashRegisterAId = 0;
  let cashRegisterBId = 0;
  let productId = 0;
  let saleToCancelId = 0;
  let foreignSaleId = 0;
  let paidSaleId = 0;

  beforeAll(async () => {
    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({
        data: { name: `Cancel Norte ${runId}`, location: "Zona A" },
      }),
      prisma.branch.create({
        data: { name: `Cancel Sur ${runId}`, location: "Zona B" },
      }),
    ]);
    branchAId = branchA.id;
    branchBId = branchB.id;

    const [managerPassword, employeePassword] = await Promise.all([
      bcrypt.hash(managerCreds.password, 10),
      bcrypt.hash(employeeCreds.password, 10),
    ]);

    const [manager, employee] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Robot Cancel Manager ${runId}`,
          email: managerCreds.email,
          password: managerPassword,
          role: "ENCARGADO",
          branches: { connect: [{ id: branchAId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Robot Cancel Employee ${runId}`,
          email: employeeCreds.email,
          password: employeePassword,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchAId }] },
        },
      }),
    ]);
    managerId = manager.id;
    employeeId = employee.id;

    const product = await prisma.product.create({
      data: {
        sku: `CANCEL-${runId}`,
        name: `Producto Cancelacion ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        costPrice: 100,
        retailPrice: 150,
      },
    });
    productId = product.id;

    await prisma.stock.createMany({
      data: [
        { productId, branchId: branchAId, quantity: 5, minStock: 1 },
        { productId, branchId: branchBId, quantity: 5, minStock: 1 },
      ],
    });

    const customer = await prisma.customer.create({
      data: { name: `Cliente Cancelacion ${runId}` },
    });
    customerId = customer.id;

    const [cashRegisterA, cashRegisterB] = await Promise.all([
      prisma.cashRegister.create({
        data: {
          initialBalance: 1000,
          status: "OPEN",
          userId: managerId,
          branchId: branchAId,
        },
      }),
      prisma.cashRegister.create({
        data: {
          initialBalance: 1000,
          status: "OPEN",
          userId: managerId,
          branchId: branchBId,
        },
      }),
    ]);
    cashRegisterAId = cashRegisterA.id;
    cashRegisterBId = cashRegisterB.id;

    const [foreignSale, paidSale] = await Promise.all([
      prisma.sale.create({
        data: {
          totalAmount: 150,
          paymentMethod: "CREDIT_ACCOUNT",
          status: "PENDING",
          balance: 150,
          customerId,
          pickedUpBy: "Robot Sur",
          branchId: branchBId,
          userId: managerId,
          cashRegisterId: cashRegisterBId,
          items: {
            create: [
              {
                productId,
                quantity: 1,
                unitPrice: 150,
                subtotal: 150,
                unitCost: 100,
              },
            ],
          },
        },
      }),
      prisma.sale.create({
        data: {
          totalAmount: 150,
          paymentMethod: "CASH",
          status: "PAID",
          balance: 0,
          customerId,
          branchId: branchAId,
          userId: managerId,
          cashRegisterId: cashRegisterAId,
          items: {
            create: [
              {
                productId,
                quantity: 1,
                unitPrice: 150,
                subtotal: 150,
                unitCost: 100,
              },
            ],
          },
        },
      }),
    ]);
    foreignSaleId = foreignSale.id;
    paidSaleId = paidSale.id;

    await prisma.payment.create({
      data: {
        amount: 150,
        paymentMethod: "CASH",
        saleId: paidSaleId,
        userId: managerId,
        branchId: branchAId,
        cashRegisterId: cashRegisterAId,
      },
    });
    await prisma.stock.update({
      where: { productId_branchId: { productId, branchId: branchAId } },
      data: { quantity: { decrement: 1 } },
    });

    const [managerLogin, employeeLogin] = await Promise.all([
      request(app).post("/api/users/login").send(managerCreds),
      request(app).post("/api/users/login").send(employeeCreds),
    ]);
    managerToken = managerLogin.body.token;
    employeeToken = employeeLogin.body.token;
  });

  afterAll(async () => {
    const saleIds = [saleToCancelId, foreignSaleId, paidSaleId].filter(
      (id) => id > 0,
    );

    await prisma.internalReceipt.deleteMany({
      where: { saleId: { in: saleIds } },
    });
    await prisma.auditLog.deleteMany({
      where: {
        entityType: "Sale",
        entityId: { in: saleIds.map(String) },
      },
    });
    await prisma.payment.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.movement.deleteMany({ where: { productId } });
    await prisma.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    await prisma.cashRegister.deleteMany({
      where: { id: { in: [cashRegisterAId, cashRegisterBId] } },
    });
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.user.deleteMany({
      where: { id: { in: [managerId, employeeId] } },
    });
    await prisma.branch.deleteMany({
      where: { id: { in: [branchAId, branchBId] } },
    });
    await prisma.$disconnect();
  });

  it("bloquea anulaciones para empleados", async () => {
    const response = await request(app)
      .post(`/api/sales/${paidSaleId}/cancel`)
      .set("Authorization", `Bearer ${employeeToken}`)
      .send({ reason: "Intento sin permisos" });

    expect(response.status).toBe(403);
  });

  it("bloquea anulaciones de otra sucursal", async () => {
    const response = await request(app)
      .post(`/api/sales/${foreignSaleId}/cancel`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ reason: "Sucursal no asignada" });

    expect(response.status).toBe(403);
  });

  it("devuelve ventas cobradas con reversa de caja y stock", async () => {
    const stockBeforeRefund = await prisma.stock.findUnique({
      where: { productId_branchId: { productId, branchId: branchAId } },
    });
    expect(stockBeforeRefund?.quantity).toBe(4);

    const response = await request(app)
      .post(`/api/sales/${paidSaleId}/cancel`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ reason: "Cliente devolvio producto pago" });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      id: paidSaleId,
      status: "CANCELLED",
      balance: 0,
    });
    expect(response.body.receipt).toMatchObject({
      receiptType: "SALE_REFUND",
      branchId: branchAId,
      saleId: paidSaleId,
    });

    const pdfResponse = await request(app)
      .get(`/api/internal-receipts/${response.body.receipt.id}/pdf`)
      .set("Authorization", `Bearer ${managerToken}`)
      .buffer(true)
      .parse(parseBinaryResponse as never);

    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers["content-type"]).toContain("application/pdf");
    expect(pdfResponse.headers["content-disposition"]).toContain("DEV");
    const pdfBody = Buffer.from(pdfResponse.body as Uint8Array);
    expect(pdfBody.subarray(0, 4).toString()).toBe("%PDF");

    const refundPayment = await prisma.payment.findFirst({
      where: {
        saleId: paidSaleId,
        amount: -150,
      },
    });
    expect(refundPayment).toMatchObject({
      paymentMethod: "CASH",
      branchId: branchAId,
      cashRegisterId: cashRegisterAId,
    });

    const stockAfterRefund = await prisma.stock.findUnique({
      where: { productId_branchId: { productId, branchId: branchAId } },
    });
    expect(stockAfterRefund?.quantity).toBe(5);

    const cashResponse = await request(app)
      .get(`/api/cash-registers/${branchAId}/active`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(cashResponse.status).toBe(200);
    expect(cashResponse.body.data.currentExpectedBalance).toBe(1000);
  });

  it("anula una venta a cuenta sin pagos, restaura stock y sale de reportes", async () => {
    const saleResponse = await request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        branchId: branchAId,
        cashRegisterId: cashRegisterAId,
        customerId,
        paymentMethod: "CREDIT_ACCOUNT",
        totalAmount: 300,
        pickedUpBy: "Robot Autorizado DNI 123",
        items: [
          {
            productId,
            quantity: 2,
            unitPrice: 150,
            subtotal: 300,
          },
        ],
      });

    expect(saleResponse.status).toBe(201);
    saleToCancelId = saleResponse.body.data.id;

    const stockAfterSale = await prisma.stock.findUnique({
      where: { productId_branchId: { productId, branchId: branchAId } },
    });
    expect(stockAfterSale?.quantity).toBe(3);

    const cancelResponse = await request(app)
      .post(`/api/sales/${saleToCancelId}/cancel`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ reason: "Cliente cancelo el pedido antes de retirar" });

    expect(cancelResponse.status).toBe(200);
    expect(cancelResponse.body.data).toMatchObject({
      id: saleToCancelId,
      status: "CANCELLED",
      balance: 0,
    });
    expect(cancelResponse.body.receipt).toMatchObject({
      receiptType: "SALE_CANCEL",
      branchId: branchAId,
      saleId: saleToCancelId,
    });

    const stockAfterCancel = await prisma.stock.findUnique({
      where: { productId_branchId: { productId, branchId: branchAId } },
    });
    expect(stockAfterCancel?.quantity).toBe(5);

    const auditLog = await prisma.auditLog.findFirst({
      where: {
        action: "SALE_CANCELLED",
        entityType: "Sale",
        entityId: String(saleToCancelId),
      },
    });
    expect(auditLog).toBeDefined();

    const pendingResponse = await request(app)
      .get(`/api/sales/pending/${branchAId}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(pendingResponse.status).toBe(200);
    expect(
      pendingResponse.body.data.some(
        (sale: { id: number }) => sale.id === saleToCancelId,
      ),
    ).toBe(false);

    const dashboardResponse = await request(app)
      .get(`/api/dashboard/summary?branchId=${branchAId}`)
      .set("Authorization", `Bearer ${managerToken}`);
    expect(dashboardResponse.status).toBe(200);
    expect(dashboardResponse.body.kpis.totalBilled).toBe(0);
    expect(dashboardResponse.body.kpis.totalDebt).toBe(0);
    expect(
      dashboardResponse.body.topProducts.some(
        (product: { productId: number; units: number }) =>
          product.productId === productId && product.units === 2,
      ),
    ).toBe(false);
  });
});

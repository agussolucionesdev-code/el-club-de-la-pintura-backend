import request from "supertest";
import bcrypt from "bcrypt";
import { IncomingMessage } from "http";
import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";

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

describe("Caja ERP: cierre con arqueo automatico", () => {
  const runId = Date.now();
  const operatorCreds = {
    email: `robot_cash_close_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let operatorToken = "";
  let operatorId = 0;
  let branchId = 0;
  let forbiddenBranchId = 0;
  let productId = 0;
  let cashRegisterId = 0;
  let saleId = 0;

  beforeAll(async () => {
    const [branch, forbiddenBranch] = await Promise.all([
      prisma.branch.create({
        data: {
          name: `Sucursal Caja Norte ${runId}`,
          location: "Zona Caja",
        },
      }),
      prisma.branch.create({
        data: {
          name: `Sucursal Caja Bloqueada ${runId}`,
          location: "Zona Caja Externa",
        },
      }),
    ]);
    branchId = branch.id;
    forbiddenBranchId = forbiddenBranch.id;

    const hashedPassword = await bcrypt.hash(operatorCreds.password, 10);
    const operator = await prisma.user.create({
      data: {
        name: `Robot Caja ${runId}`,
        email: operatorCreds.email,
        password: hashedPassword,
        role: "ENCARGADO",
        branches: { connect: [{ id: branchId }] },
      },
    });
    operatorId = operator.id;

    const product = await prisma.product.create({
      data: {
        sku: `ACL-CASH-${runId}`,
        name: `Producto Caja ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        costPrice: 100,
        retailPrice: 200,
      },
    });
    productId = product.id;

    const cashRegister = await prisma.cashRegister.create({
      data: {
        initialBalance: 100,
        branchId,
        userId: operatorId,
        status: "OPEN",
      },
    });
    cashRegisterId = cashRegister.id;

    const sale = await prisma.sale.create({
      data: {
        totalAmount: 1500,
        paymentMethod: "MIXED",
        status: "PAID",
        balance: 0,
        branchId,
        userId: operatorId,
        cashRegisterId,
      },
    });
    saleId = sale.id;

    await prisma.saleItem.create({
      data: {
        saleId,
        productId,
        quantity: 1,
        unitPrice: 1500,
        subtotal: 1500,
        unitCost: 100,
      },
    });

    await prisma.payment.createMany({
      data: [
        {
          amount: 1000,
          paymentMethod: "CASH",
          saleId,
          userId: operatorId,
          branchId,
          cashRegisterId,
        },
        {
          amount: 500,
          paymentMethod: "CARD",
          saleId,
          userId: operatorId,
          branchId,
          cashRegisterId,
        },
        {
          amount: -200,
          paymentMethod: "CASH",
          saleId,
          userId: operatorId,
          branchId,
          cashRegisterId,
        },
      ],
    });

    await prisma.expense.create({
      data: {
        amount: 150,
        reason: "Egreso operativo de prueba",
        category: "TEST",
        type: "VARIABLE",
        cashRegisterId,
        userId: operatorId,
        branchId,
      },
    });

    await prisma.syncOperation.createMany({
      data: [
        {
          idempotencyKey: `cash-close-processing-${runId}`,
          branchId,
          userId: operatorId,
          type: "POST /sales",
          status: "PROCESSING",
          payload: { branchId },
        },
        {
          idempotencyKey: `cash-close-rejected-${runId}`,
          branchId,
          userId: operatorId,
          type: "PUT /stock/update",
          status: "REJECTED",
          payload: { branchId },
          error: "Conflicto de prueba",
          processedAt: new Date(),
        },
      ],
    });

    operatorToken = generateTestToken({ userId: operatorId, role: "ENCARGADO", branchIds: [branchId] });
  });

  afterAll(async () => {
    await prisma.internalReceipt.deleteMany({
      where: { cashRegisterId },
    });
    await prisma.auditLog.deleteMany({
      where: { actorUserId: operatorId },
    });
    await prisma.syncOperation.deleteMany({
      where: { userId: operatorId },
    });
    await prisma.expense.deleteMany({ where: { cashRegisterId } });
    await prisma.payment.deleteMany({ where: { saleId } });
    await prisma.saleItem.deleteMany({ where: { saleId } });
    await prisma.sale.deleteMany({ where: { id: saleId } });
    await prisma.movement.deleteMany({ where: { userId: operatorId } });
    await prisma.cashRegister.deleteMany({ where: { id: cashRegisterId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { email: operatorCreds.email } });
    await prisma.branch.deleteMany({
      where: { id: { in: [branchId, forbiddenBranchId] } },
    });
    await prisma.$disconnect();
  });

  it("calcula esperado, contado, diferencia, medios de pago y sync pendiente al cerrar", async () => {
    const activeResponse = await request(app)
      .get(`/api/cash-registers/${branchId}/active`)
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(activeResponse.status).toBe(200);
    expect(activeResponse.body.data.currentExpectedBalance).toBe(750);
    expect(activeResponse.body.data.cashSummary).toMatchObject({
      totalCashPayments: 800,
      totalNonCashPayments: 500,
      totalPayments: 1300,
      totalExpenses: 150,
      expectedBalance: 750,
      paymentsCount: 3,
      expensesCount: 1,
      paymentsByMethod: {
        CASH: 800,
        CARD: 500,
      },
    });
    expect(activeResponse.body.data.syncSafety).toMatchObject({
      localPendingOperations: 0,
      localFailedOperations: 0,
      serverPendingSyncOperations: 1,
      serverRejectedSyncOperations: 1,
      canClose: false,
    });

    const blockedCloseResponse = await request(app)
      .post(`/api/cash-registers/${cashRegisterId}/close`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        actualBalance: 740,
        observations: "Intento con sync pendiente",
        localPendingOperations: 2,
        localFailedOperations: 1,
        denominationBreakdown: [
          { denomination: 500, quantity: 1 },
          { denomination: 100, quantity: 2 },
          { denomination: 20, quantity: 2 },
        ],
      });

    expect(blockedCloseResponse.status).toBe(409);
    expect(blockedCloseResponse.body.data).toMatchObject({
      cashRegisterId,
      expectedBalance: 750,
      actualBalance: 740,
      discrepancy: -10,
      localPendingOperations: 2,
      localFailedOperations: 1,
      serverPendingSyncOperations: 1,
      serverRejectedSyncOperations: 1,
    });

    await prisma.syncOperation.updateMany({
      where: {
        userId: operatorId,
        branchId,
        status: "PROCESSING",
      },
      data: {
        status: "ACCEPTED",
        processedAt: new Date(),
      },
    });

    const blockedConflictResponse = await request(app)
      .post(`/api/cash-registers/${cashRegisterId}/close`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        actualBalance: 740,
        observations: "Intento con conflictos de sync",
        localPendingOperations: 0,
        localFailedOperations: 1,
        denominationBreakdown: [
          { denomination: 500, quantity: 1 },
          { denomination: 100, quantity: 2 },
          { denomination: 20, quantity: 2 },
        ],
      });

    expect(blockedConflictResponse.status).toBe(409);
    expect(blockedConflictResponse.body.data).toMatchObject({
      cashRegisterId,
      expectedBalance: 750,
      actualBalance: 740,
      discrepancy: -10,
      localPendingOperations: 0,
      localFailedOperations: 1,
      serverPendingSyncOperations: 0,
      serverRejectedSyncOperations: 1,
    });

    await prisma.syncOperation.updateMany({
      where: {
        userId: operatorId,
        branchId,
        status: "REJECTED",
      },
      data: {
        status: "ACCEPTED",
        processedAt: new Date(),
      },
    });

    const closeResponse = await request(app)
      .post(`/api/cash-registers/${cashRegisterId}/close`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        actualBalance: 740,
        observations: "Faltante robotizado de prueba",
        localPendingOperations: 0,
        localFailedOperations: 0,
        denominationBreakdown: [
          { denomination: 500, quantity: 1 },
          { denomination: 100, quantity: 2 },
          { denomination: 20, quantity: 2 },
        ],
      });

    expect(closeResponse.status).toBe(200);
    expect(closeResponse.body.data).toMatchObject({
      status: "CLOSED",
      expectedBalance: 750,
      actualBalance: 740,
      discrepancy: -10,
      cashSummary: {
        totalCashPayments: 800,
        totalNonCashPayments: 500,
        totalPayments: 1300,
        totalExpenses: 150,
        expectedBalance: 750,
        actualBalance: 740,
        discrepancy: -10,
        localPendingOperations: 0,
        localFailedOperations: 0,
        serverPendingSyncOperations: 0,
        serverRejectedSyncOperations: 0,
        denominationTotal: 740,
        countedByDenominations: true,
      },
    });
    expect(closeResponse.body.receipt.receiptNumber).toContain("CJA");
    expect(closeResponse.body.receipt.payload).toMatchObject({
      totalCashPayments: 800,
      totalNonCashPayments: 500,
      totalExpenses: 150,
      discrepancy: -10,
      localPendingOperations: 0,
      localFailedOperations: 0,
      serverPendingSyncOperations: 0,
      serverRejectedSyncOperations: 0,
      denominationTotal: 740,
      countedByDenominations: true,
    });
    expect(closeResponse.body.receipt.payload.denominationBreakdown).toEqual([
      { denomination: 500, quantity: 1, subtotal: 500 },
      { denomination: 100, quantity: 2, subtotal: 200 },
      { denomination: 20, quantity: 2, subtotal: 40 },
    ]);

    const audit = await prisma.auditLog.findFirst({
      where: {
        actorUserId: operatorId,
        entityType: "CashRegister",
        entityId: String(cashRegisterId),
        action: "cash_register.closed",
      },
    });

    expect(audit).toBeTruthy();

    const pdfResponse = await request(app)
      .get(`/api/internal-receipts/${closeResponse.body.receipt.id}/pdf`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .buffer(true)
      .parse(parseBinaryResponse as never);

    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers["content-type"]).toContain("application/pdf");
    expect(pdfResponse.headers["content-disposition"]).toContain("CJA");
    const pdfBody = Buffer.from(pdfResponse.body as Uint8Array);
    expect(pdfBody.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("bloquea consulta de caja activa sobre sucursales no asignadas", async () => {
    const response = await request(app)
      .get(`/api/cash-registers/${forbiddenBranchId}/active`)
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(response.status).toBe(403);
    expect(response.body.error).toContain("No tienes permisos");
  });

  it("rechaza cierres con dinero contado invalido", async () => {
    const invalidRegister = await prisma.cashRegister.create({
      data: {
        initialBalance: 100,
        branchId,
        userId: operatorId,
        status: "OPEN",
      },
    });

    const response = await request(app)
      .post(`/api/cash-registers/${invalidRegister.id}/close`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ actualBalance: -1 });

    expect(response.status).toBe(400);
    // Validation caught by Zod (returns generic message) or controller (returns specific message)
    expect(response.body.error ?? response.body.message).toBeTruthy();

    await prisma.cashRegister.delete({ where: { id: invalidRegister.id } });
  });

  it("rechaza cierres cuando el conteo por denominaciones no coincide", async () => {
    const invalidRegister = await prisma.cashRegister.create({
      data: {
        initialBalance: 100,
        branchId,
        userId: operatorId,
        status: "OPEN",
      },
    });

    const response = await request(app)
      .post(`/api/cash-registers/${invalidRegister.id}/close`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        actualBalance: 1000,
        denominationBreakdown: [{ denomination: 500, quantity: 1 }],
      });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("denominaciones");

    await prisma.cashRegister.delete({ where: { id: invalidRegister.id } });
  });
});

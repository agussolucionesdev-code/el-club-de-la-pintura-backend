import request from "supertest";
import bcrypt from "bcrypt";
import { IncomingMessage } from "http";
import app from "../src/app";
import prisma from "../src/config/db";
import { buildInternalReceiptNumber } from "../src/modules/internal-receipt/internal-receipt.service";

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

describe("Comprobantes internos imprimibles por sucursal", () => {
  const runId = Date.now();
  const managerCreds = {
    email: `robot_receipts_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let managerToken = "";
  let managerId = 0;
  let branchAId = 0;
  let branchBId = 0;
  let expenseReceiptId = "";
  let cashCloseReceiptId = "";
  let foreignReceiptId = "";

  beforeAll(async () => {
    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({
        data: { name: `Receipts Norte ${runId}`, location: "Zona A" },
      }),
      prisma.branch.create({
        data: { name: `Receipts Sur ${runId}`, location: "Zona B" },
      }),
    ]);

    branchAId = branchA.id;
    branchBId = branchB.id;

    const hashedPassword = await bcrypt.hash(managerCreds.password, 10);
    const manager = await prisma.user.create({
      data: {
        name: `Robot Receipts ${runId}`,
        email: managerCreds.email,
        password: hashedPassword,
        role: "ENCARGADO",
        branches: { connect: [{ id: branchAId }] },
      },
    });
    managerId = manager.id;

    const expenseReceipt = await prisma.internalReceipt.create({
      data: {
        receiptNumber: buildInternalReceiptNumber({
          receiptType: "EXPENSE",
          branchId: branchAId,
          cashRegisterId: 9001,
          sourceId: `expense-${runId}`,
        }),
        receiptType: "EXPENSE",
        branchId: branchAId,
        cashRegisterId: 9001,
        payload: {
          expenseId: 9001,
          amount: 1250,
          reason: "Reposicion de insumos de limpieza",
          category: "LIMPIEZA",
          type: "VARIABLE",
          previousExpectedBalance: 10000,
          newExpectedBalance: 8750,
        },
        createdBy: managerId,
      },
    });
    expenseReceiptId = expenseReceipt.id;

    const cashCloseReceipt = await prisma.internalReceipt.create({
      data: {
        receiptNumber: buildInternalReceiptNumber({
          receiptType: "CASH_CLOSE",
          branchId: branchAId,
          cashRegisterId: 9002,
          sourceId: `cash-${runId}`,
        }),
        receiptType: "CASH_CLOSE",
        branchId: branchAId,
        cashRegisterId: 9002,
        payload: {
          cashRegisterId: 9002,
          openedAt: new Date("2026-04-13T09:00:00.000Z").toISOString(),
          closedAt: new Date("2026-04-13T18:00:00.000Z").toISOString(),
          initialBalance: 5000,
          expectedBalance: 17250,
          actualBalance: 17100,
          discrepancy: -150,
          observations: "Faltante menor auditado en prueba",
          paymentsCount: 7,
          expensesCount: 2,
        },
        createdBy: managerId,
      },
    });
    cashCloseReceiptId = cashCloseReceipt.id;

    const foreignReceipt = await prisma.internalReceipt.create({
      data: {
        receiptNumber: buildInternalReceiptNumber({
          receiptType: "EXPENSE",
          branchId: branchBId,
          cashRegisterId: 9101,
          sourceId: `foreign-${runId}`,
        }),
        receiptType: "EXPENSE",
        branchId: branchBId,
        cashRegisterId: 9101,
        payload: {
          expenseId: 9101,
          amount: 900,
          reason: "Intento fuera de alcance",
          category: "OTROS",
          type: "VARIABLE",
        },
        createdBy: managerId,
      },
    });
    foreignReceiptId = foreignReceipt.id;

    const loginResponse = await request(app)
      .post("/api/users/login")
      .send(managerCreds);

    managerToken = loginResponse.body.token;
  });

  afterAll(async () => {
    await prisma.internalReceipt.deleteMany({
      where: { id: { in: [expenseReceiptId, cashCloseReceiptId, foreignReceiptId] } },
    });
    await prisma.user.deleteMany({ where: { email: managerCreds.email } });
    await prisma.branch.deleteMany({
      where: { id: { in: [branchAId, branchBId] } },
    });
    await prisma.$disconnect();
  });

  it("genera PDF interno para egresos", async () => {
    const response = await request(app)
      .get(`/api/internal-receipts/${expenseReceiptId}/pdf`)
      .set("Authorization", `Bearer ${managerToken}`)
      .buffer(true)
      .parse(parseBinaryResponse as never);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toContain("EGR");

    const body = Buffer.from(response.body as Uint8Array);
    expect(body.length).toBeGreaterThan(1000);
    expect(body.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("genera PDF interno para cierres de caja", async () => {
    const response = await request(app)
      .get(`/api/internal-receipts/${cashCloseReceiptId}/pdf`)
      .set("Authorization", `Bearer ${managerToken}`)
      .buffer(true)
      .parse(parseBinaryResponse as never);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["content-disposition"]).toContain("CJA");

    const body = Buffer.from(response.body as Uint8Array);
    expect(body.length).toBeGreaterThan(1000);
    expect(body.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("bloquea PDFs de comprobantes internos de otra sucursal", async () => {
    const response = await request(app)
      .get(`/api/internal-receipts/${foreignReceiptId}/pdf`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(403);
  });
});

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

describe("Inventario ERP: transferencias y reposicion sugerida", () => {
  const runId = Date.now();
  const operatorCreds = {
    email: `robot_stock_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let operatorToken = "";
  let operatorId = 0;
  let branchAId = 0;
  let branchBId = 0;
  let branchCId = 0;
  let productId = 0;
  let transferId = "";
  let transferInternalReceiptId = "";

  beforeAll(async () => {
    const [branchA, branchB, branchC] = await Promise.all([
      prisma.branch.create({
        data: { name: `Sucursal Stock Norte ${runId}`, location: "Zona A" },
      }),
      prisma.branch.create({
        data: { name: `Sucursal Stock Sur ${runId}`, location: "Zona B" },
      }),
      prisma.branch.create({
        data: { name: `Sucursal Stock Oeste ${runId}`, location: "Zona C" },
      }),
    ]);

    branchAId = branchA.id;
    branchBId = branchB.id;
    branchCId = branchC.id;

    const product = await prisma.product.create({
      data: {
        sku: `ACL-STOCK-${runId}`,
        name: `Producto Stock ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        costPrice: 100,
        retailPrice: 180,
      },
    });

    productId = product.id;

    await prisma.stock.createMany({
      data: [
        {
          productId,
          branchId: branchAId,
          quantity: 7,
          minStock: 10,
          criticalStock: 2,
        },
        {
          productId,
          branchId: branchBId,
          quantity: 30,
          minStock: 5,
          criticalStock: 1,
        },
        {
          productId,
          branchId: branchCId,
          quantity: 1,
          minStock: 10,
          criticalStock: 2,
        },
      ],
    });

    const hashedPassword = await bcrypt.hash(operatorCreds.password, 10);
    const operator = await prisma.user.create({
      data: {
        name: `Robot Stock ${runId}`,
        email: operatorCreds.email,
        password: hashedPassword,
        role: "ENCARGADO",
        branches: {
          connect: [{ id: branchAId }, { id: branchBId }],
        },
      },
    });
    operatorId = operator.id;

    operatorToken = generateTestToken({ userId: operatorId, role: "ENCARGADO", branchIds: [branchAId, branchBId] });
  });

  afterAll(async () => {
    await prisma.internalReceipt.deleteMany({
      where: { createdBy: operatorId },
    });
    await prisma.auditLog.deleteMany({
      where: { actorUserId: operatorId },
    });
    await prisma.movement.deleteMany({ where: { productId } });
    await prisma.stockTransfer.deleteMany({ where: { productId } });
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { email: operatorCreds.email } });
    await prisma.branch.deleteMany({
      where: { id: { in: [branchAId, branchBId, branchCId] } },
    });
    await prisma.$disconnect();
  });

  it("registra una transferencia y la devuelve con trazabilidad legible", async () => {
    const transferResponse = await request(app)
      .post("/api/stock/transfers")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        productId,
        fromBranchId: branchAId,
        toBranchId: branchBId,
        quantity: 2,
        reason: "Reposicion robotizada entre sucursales",
      });

    expect(transferResponse.status).toBe(201);
    expect(transferResponse.body.data.transfer.quantity).toBe(2);
    expect(transferResponse.body.data.transfer.internalReceiptNumber).toContain(
      "TRF",
    );
    expect(transferResponse.body.data.source.quantity).toBe(5);

    transferId = transferResponse.body.data.transfer.id;
    transferInternalReceiptId =
      transferResponse.body.data.transfer.internalReceiptId;

    const pdfResponse = await request(app)
      .get(`/api/internal-receipts/${transferInternalReceiptId}/pdf`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .buffer(true)
      .parse(parseBinaryResponse as never);

    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers["content-type"]).toContain("application/pdf");
    expect(pdfResponse.headers["content-disposition"]).toContain("TRF");
    const pdfBody = Buffer.from(pdfResponse.body as Uint8Array);
    expect(pdfBody.subarray(0, 4).toString()).toBe("%PDF");

    const historyResponse = await request(app)
      .get(`/api/stock/transfers?branchId=${branchAId}`)
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(historyResponse.status).toBe(200);

    const transfer = historyResponse.body.data.find(
      (item: { id: string }) => item.id === transferId,
    );

    expect(transfer).toMatchObject({
      id: transferId,
      productId,
      fromBranchId: branchAId,
      toBranchId: branchBId,
      quantity: 2,
      status: "COMPLETED",
      product: { id: productId },
      fromBranch: { id: branchAId },
      toBranch: { id: branchBId },
      internalReceiptId: transferInternalReceiptId,
    });

    const targetHistoryResponse = await request(app)
      .get(`/api/stock/transfers?branchId=${branchBId}`)
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(targetHistoryResponse.status).toBe(200);
    const targetTransfer = targetHistoryResponse.body.data.find(
      (item: { id: string }) => item.id === transferId,
    );

    expect(targetTransfer.internalReceiptId).toBeDefined();
    expect(targetTransfer.internalReceiptId).not.toBe(transferInternalReceiptId);

    const targetPdfResponse = await request(app)
      .get(`/api/internal-receipts/${targetTransfer.internalReceiptId}/pdf`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .buffer(true)
      .parse(parseBinaryResponse as never);

    expect(targetPdfResponse.status).toBe(200);
    expect(targetPdfResponse.headers["content-disposition"]).toContain("TRF");
  });

  it("calcula reposicion por sucursal y reserva el consolidado para administradores", async () => {
    const branchResponse = await request(app)
      .get(`/api/stock/reorder-suggestions?branchId=${branchAId}`)
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(branchResponse.status).toBe(200);
    const branchSuggestion = branchResponse.body.data.find(
      (item: { productId: number; branchId: number }) =>
        item.productId === productId && item.branchId === branchAId,
    );

    expect(branchSuggestion).toBeDefined();
    expect(branchSuggestion.minStock).toBe(10);
    expect(branchSuggestion.suggestedQuantity).toBe(
      branchSuggestion.minStock * 2 - branchSuggestion.quantity,
    );

    const consolidatedResponse = await request(app)
      .get("/api/stock/reorder-suggestions?branchId=0")
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(consolidatedResponse.status).toBe(403);
  });

  it("bloquea transferencias y consultas de sucursales no asignadas", async () => {
    const transferResponse = await request(app)
      .post("/api/stock/transfers")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({
        productId,
        fromBranchId: branchCId,
        toBranchId: branchAId,
        quantity: 1,
        reason: "Intento fuera de alcance",
      });

    expect(transferResponse.status).toBe(403);

    const reorderResponse = await request(app)
      .get(`/api/stock/reorder-suggestions?branchId=${branchCId}`)
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(reorderResponse.status).toBe(403);
  });
});

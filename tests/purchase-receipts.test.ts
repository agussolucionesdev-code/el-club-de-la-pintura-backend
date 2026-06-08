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

describe("Compras ERP con comprobantes internos", () => {
  const runId = Date.now();
  const managerCreds = {
    email: `robot_purchases_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let managerToken = "";
  let managerId = 0;
  let branchId = 0;
  let supplierId = 0;
  let productId = 0;
  let purchaseOrderId = "";
  let purchaseReceiptId = "";
  let orderInternalReceiptId = "";
  let receiptInternalReceiptId = "";

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `Compras Norte ${runId}`, location: "Deposito" },
    });
    branchId = branch.id;

    const supplier = await prisma.supplier.create({
      data: {
        companyName: `Proveedor Compras ${runId}`,
        phone: "1133445566",
        email: `proveedor_${runId}@test.com`,
      },
    });
    supplierId = supplier.id;

    const product = await prisma.product.create({
      data: {
        sku: `COMPRA-${runId}`,
        name: `Latex Compra ${runId}`,
        brand: "Robot",
        category: "Pinturas",
        costPrice: 100,
        retailPrice: 190,
        supplierId,
      },
    });
    productId = product.id;

    await prisma.stock.create({
      data: {
        productId,
        branchId,
        quantity: 2,
        minStock: 5,
      },
    });

    const hashedPassword = await bcrypt.hash(managerCreds.password, 10);
    const manager = await prisma.user.create({
      data: {
        name: `Robot Compras ${runId}`,
        email: managerCreds.email,
        password: hashedPassword,
        role: "ENCARGADO",
        branches: { connect: [{ id: branchId }] },
      },
    });
    managerId = manager.id;

    managerToken = generateTestToken({ userId: managerId, role: "ENCARGADO", branchIds: [branchId] });
  });

  afterAll(async () => {
    await prisma.internalReceipt.deleteMany({
      where: { createdBy: managerId },
    });
    await prisma.auditLog.deleteMany({
      where: { actorUserId: managerId },
    });
    await prisma.movement.deleteMany({ where: { productId } });
    if (purchaseReceiptId) {
      await prisma.purchaseReceipt.deleteMany({
        where: { id: purchaseReceiptId },
      });
    }
    if (purchaseOrderId) {
      await prisma.purchaseOrder.deleteMany({
        where: { id: purchaseOrderId },
      });
    }
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.user.deleteMany({ where: { email: managerCreds.email } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  it("crea ordenes de compra con comprobante interno imprimible", async () => {
    const response = await request(app)
      .post("/api/purchases/orders")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        branchId,
        supplierId,
        items: [{ productId, quantity: 3, unitCost: 120 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      branchId,
      supplierId,
      status: "DRAFT",
    });
    expect(response.body.data.internalReceiptNumber).toContain("OC");

    purchaseOrderId = response.body.data.id;
    orderInternalReceiptId = response.body.data.internalReceiptId;

    const pdfResponse = await request(app)
      .get(`/api/internal-receipts/${orderInternalReceiptId}/pdf`)
      .set("Authorization", `Bearer ${managerToken}`)
      .buffer(true)
      .parse(parseBinaryResponse as never);

    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers["content-type"]).toContain("application/pdf");
    expect(pdfResponse.headers["content-disposition"]).toContain("OC");
    const pdfBody = Buffer.from(pdfResponse.body as Uint8Array);
    expect(pdfBody.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("recibe compras, actualiza stock/costo y emite comprobante interno", async () => {
    const response = await request(app)
      .post("/api/purchases/receipts")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        branchId,
        supplierId,
        purchaseOrderId,
        reason: "Remito interno de prueba",
        items: [{ productId, quantity: 3, unitCost: 125 }],
      });

    expect(response.status).toBe(201);
    expect(response.body.data.receipt).toMatchObject({
      branchId,
      supplierId,
      purchaseOrderId,
    });
    expect(response.body.data.receipt.internalReceiptNumber).toContain("REC");

    purchaseReceiptId = response.body.data.receipt.id;
    receiptInternalReceiptId = response.body.data.receipt.internalReceiptId;

    const [stock, product, order] = await Promise.all([
      prisma.stock.findUnique({
        where: { productId_branchId: { productId, branchId } },
      }),
      prisma.product.findUnique({ where: { id: productId } }),
      prisma.purchaseOrder.findUnique({ where: { id: purchaseOrderId } }),
    ]);

    expect(stock?.quantity).toBe(5);
    expect(product?.costPrice).toBe(125);
    expect(order?.status).toBe("RECEIVED");

    const pdfResponse = await request(app)
      .get(`/api/internal-receipts/${receiptInternalReceiptId}/pdf`)
      .set("Authorization", `Bearer ${managerToken}`)
      .buffer(true)
      .parse(parseBinaryResponse as never);

    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers["content-type"]).toContain("application/pdf");
    expect(pdfResponse.headers["content-disposition"]).toContain("REC");
    const pdfBody = Buffer.from(pdfResponse.body as Uint8Array);
    expect(pdfBody.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("lista compras y recepciones con referencia al comprobante interno", async () => {
    const [ordersResponse, receiptsResponse, internalReceiptsResponse] =
      await Promise.all([
        request(app)
          .get(`/api/purchases/orders?branchId=${branchId}`)
          .set("Authorization", `Bearer ${managerToken}`),
        request(app)
          .get(`/api/purchases/receipts?branchId=${branchId}`)
          .set("Authorization", `Bearer ${managerToken}`),
        request(app)
          .get(
            `/api/internal-receipts?branchId=${branchId}&receiptType=PURCHASE_RECEIPT`,
          )
          .set("Authorization", `Bearer ${managerToken}`),
      ]);

    expect(ordersResponse.status).toBe(200);
    expect(receiptsResponse.status).toBe(200);
    expect(internalReceiptsResponse.status).toBe(200);

    const order = ordersResponse.body.data.find(
      (item: { id: string }) => item.id === purchaseOrderId,
    );
    const receipt = receiptsResponse.body.data.find(
      (item: { id: string }) => item.id === purchaseReceiptId,
    );

    expect(order.internalReceiptId).toBe(orderInternalReceiptId);
    expect(receipt.internalReceiptId).toBe(receiptInternalReceiptId);
    expect(
      internalReceiptsResponse.body.data.some(
        (item: { id: string }) => item.id === receiptInternalReceiptId,
      ),
    ).toBe(true);
  });
});

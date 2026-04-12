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

describe("Tickets internos de venta por sucursal", () => {
  const runId = Date.now();
  const managerCreds = {
    email: `robot_sales_${runId}@elclub.com`,
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
  let productId = 0;
  let saleAId = 0;
  let saleBId = 0;

  beforeAll(async () => {
    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({
        data: { name: `Tickets Norte ${runId}`, location: "Zona A" },
      }),
      prisma.branch.create({
        data: { name: `Tickets Sur ${runId}`, location: "Zona B" },
      }),
    ]);

    branchAId = branchA.id;
    branchBId = branchB.id;

    const hashedPassword = await bcrypt.hash(managerCreds.password, 10);
    const manager = await prisma.user.create({
      data: {
        name: `Robot Tickets ${runId}`,
        email: managerCreds.email,
        password: hashedPassword,
        role: "ENCARGADO",
        branches: { connect: [{ id: branchAId }] },
      },
    });
    managerId = manager.id;

    const product = await prisma.product.create({
      data: {
        sku: `TICKET-${runId}`,
        name: `Rodillo Robot ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        costPrice: 100,
        retailPrice: 250,
      },
    });
    productId = product.id;

    await prisma.stock.createMany({
      data: [
        { productId, branchId: branchAId, quantity: 10, minStock: 2 },
        { productId, branchId: branchBId, quantity: 10, minStock: 2 },
      ],
    });

    const [customerA, customerB] = await Promise.all([
      prisma.customer.create({
        data: {
          name: `Cliente Ticket Norte ${runId}`,
          document: `DNI-A-${runId}`,
        },
      }),
      prisma.customer.create({
        data: {
          name: `Cliente Ticket Sur ${runId}`,
          document: `DNI-B-${runId}`,
        },
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

    const branchBSale = await prisma.sale.create({
      data: {
        totalAmount: 250,
        paymentMethod: "CASH",
        status: "PAID",
        balance: 0,
        customerId: customerBId,
        branchId: branchBId,
        userId: managerId,
        cashRegisterId: cashRegisterBId,
        items: {
          create: [
            {
              productId,
              quantity: 1,
              unitPrice: 250,
              subtotal: 250,
              unitCost: 100,
            },
          ],
        },
      },
    });
    saleBId = branchBSale.id;

    await prisma.internalReceipt.create({
      data: {
        receiptNumber: buildInternalReceiptNumber({
          receiptType: "SALE",
          branchId: branchBId,
          cashRegisterId: cashRegisterBId,
          sourceId: saleBId,
        }),
        receiptType: "SALE",
        branchId: branchBId,
        cashRegisterId: cashRegisterBId,
        saleId: saleBId,
        payload: {
          saleId: saleBId,
          totalAmount: 250,
          paymentMethod: "CASH",
        },
        createdBy: managerId,
      },
    });

    const loginResponse = await request(app)
      .post("/api/users/login")
      .send(managerCreds);

    managerToken = loginResponse.body.token;
  });

  afterAll(async () => {
    const saleIds = [saleAId, saleBId].filter((id) => id > 0);

    await prisma.internalReceipt.deleteMany({
      where: { saleId: { in: saleIds } },
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
    await prisma.customer.deleteMany({
      where: { id: { in: [customerAId, customerBId] } },
    });
    await prisma.user.deleteMany({ where: { email: managerCreds.email } });
    await prisma.branch.deleteMany({
      where: { id: { in: [branchAId, branchBId] } },
    });
    await prisma.$disconnect();
  });

  it("crea una venta con comprobante interno y permite reimprimir su PDF", async () => {
    const saleResponse = await request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        branchId: branchAId,
        cashRegisterId: cashRegisterAId,
        customerId: customerAId,
        paymentMethod: "CASH",
        totalAmount: 500,
        items: [
          {
            productId,
            quantity: 2,
            unitPrice: 250,
            subtotal: 500,
          },
        ],
      });

    expect(saleResponse.status).toBe(201);
    expect(saleResponse.body.receipt).toMatchObject({
      receiptType: "SALE",
      branchId: branchAId,
      cashRegisterId: cashRegisterAId,
    });
    saleAId = saleResponse.body.data.id;

    const stock = await prisma.stock.findUnique({
      where: {
        productId_branchId: {
          productId,
          branchId: branchAId,
        },
      },
    });
    expect(stock?.quantity).toBe(8);

    const pdfResponse = await request(app)
      .get(`/api/sales/${saleAId}/receipt/pdf`)
      .set("Authorization", `Bearer ${managerToken}`)
      .buffer(true)
      .parse(parseBinaryResponse as never);

    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers["content-type"]).toContain("application/pdf");
    expect(pdfResponse.headers["content-disposition"]).toContain("VTA");

    const body = Buffer.from(pdfResponse.body as Uint8Array);
    expect(body.length).toBeGreaterThan(1000);
    expect(body.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("bloquea la reimpresion de tickets de otra sucursal", async () => {
    const response = await request(app)
      .get(`/api/sales/${saleBId}/receipt/pdf`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(response.status).toBe(403);
  });
});

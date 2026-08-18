/**
 * El total de Comprobantes describe el FILTRO, no la página.
 *
 * La pantalla mostraba la suma de las filas que habían llegado —topeadas en
 * 500— rotulada "monto trazado". Es el error más caro de todos, porque el
 * número parece exacto y nadie lo revisa: con dos sucursales generando un
 * comprobante por venta, el tope se pasa en semanas y a partir de ahí el total
 * miente sin avisar.
 *
 * Estos tests fijan la propiedad que lo impide: **pedir menos filas no cambia
 * el total**.
 */
import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import { buildInternalReceiptNumber } from "../src/modules/internal-receipt/internal-receipt.service";

describe("Resumen de comprobantes internos", () => {
  const runId = Date.now();
  let branchId = 0;
  let adminId = 0;
  let adminToken = "";

  /** Cuánto suma cada comprobante que sembramos. */
  const MONTOS = [1000, 2500, 4000, 550, 7200, 300, 12000];
  /** Y una transferencia de stock, cuyas "unidades" NO son plata. */
  const UNIDADES_TRANSFERIDAS = 99;

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `Resumen ${runId}`, location: "A" },
    });
    branchId = branch.id;

    const admin = await prisma.user.create({
      data: {
        name: `Admin Resumen ${runId}`,
        email: `resumen_${runId}@x.com`,
        password: await bcrypt.hash("supersecretpassword", 10),
        role: "ADMIN",
        branches: { connect: [{ id: branchId }] },
      },
    });
    adminId = admin.id;
    adminToken = generateTestToken({
      userId: admin.id,
      role: "ADMIN",
      branchIds: [branchId],
    });

    // Comprobantes de dinero. Se usan las cuatro claves que la pantalla lee,
    // para que el SQL y el frontend tengan que coincidir de verdad.
    const claves = [
      "totalAmount",
      "amount",
      "estimatedTotal",
      "actualBalance",
      "totalAmount",
      "amount",
      "estimatedTotal",
    ];
    for (let i = 0; i < MONTOS.length; i++) {
      await prisma.internalReceipt.create({
        data: {
          receiptNumber: buildInternalReceiptNumber({
            receiptType: i % 2 === 0 ? "SALE" : "EXPENSE",
            branchId,
            sourceId: `R${runId}${i}`,
          }),
          receiptType: i % 2 === 0 ? "SALE" : "EXPENSE",
          branchId,
          createdBy: adminId,
          payload: { [claves[i] as string]: MONTOS[i] },
        },
      });
    }

    // Una transferencia de stock: sus unidades no son pesos.
    await prisma.internalReceipt.create({
      data: {
        receiptNumber: buildInternalReceiptNumber({
          receiptType: "STOCK_TRANSFER",
          branchId,
          sourceId: `T${runId}`,
        }),
        receiptType: "STOCK_TRANSFER",
        branchId,
        createdBy: adminId,
        payload: { quantity: UNIDADES_TRANSFERIDAS },
      },
    });
  });

  afterAll(async () => {
    await prisma.internalReceipt.deleteMany({ where: { branchId } });
    await prisma.user.delete({ where: { id: adminId } }).catch(() => {});
    await prisma.branch.delete({ where: { id: branchId } }).catch(() => {});
    await prisma.$disconnect();
  });

  const traer = (params: Record<string, string | number> = {}) =>
    request(app)
      .get("/api/internal-receipts")
      .query({ branchId, ...params })
      .set("Authorization", `Bearer ${adminToken}`);

  const esperado = MONTOS.reduce((a, b) => a + b, 0);

  it("suma TODO lo que matchea el filtro, no lo que entró en la página", async () => {
    const res = await traer();

    expect(res.status).toBe(200);
    expect(res.body.summary.totalAmount).toBeCloseTo(esperado, 2);
    // 7 de dinero + 1 de stock.
    expect(res.body.summary.count).toBe(MONTOS.length + 1);
  });

  it("🔒 pedir menos filas NO cambia el total", async () => {
    // Ésta es la propiedad que impide que el número mienta al crecer el
    // volumen: la página es una ventana, el total describe el filtro entero.
    const completo = await traer();
    const recortado = await traer({ limit: 2 });

    expect(recortado.status).toBe(200);
    expect(recortado.body.data.length).toBe(2);
    expect(recortado.body.summary.totalAmount).toBeCloseTo(
      completo.body.summary.totalAmount,
      2,
    );
    expect(recortado.body.summary.count).toBe(completo.body.summary.count);
    // Y avisa que hay más, para que la pantalla pueda ofrecer traerlas.
    expect(recortado.body.pageInfo.hasNextPage).toBe(true);
    expect(recortado.body.pageInfo.nextCursor).toBeTruthy();
  });

  it("las unidades de una transferencia de stock no se suman como pesos", async () => {
    const res = await traer();
    // Si `quantity` se colara al total, el número subiría en 99.
    expect(res.body.summary.totalAmount).toBeCloseTo(esperado, 2);
    expect(res.body.summary.totalAmount).not.toBeCloseTo(
      esperado + UNIDADES_TRANSFERIDAS,
      2,
    );
  });

  it("filtrar por tipo mueve el total al subconjunto correcto", async () => {
    const soloGastos = await traer({ receiptType: "EXPENSE" });
    const esperadoGastos = MONTOS.filter((_, i) => i % 2 === 1).reduce(
      (a, b) => a + b,
      0,
    );

    expect(soloGastos.status).toBe(200);
    expect(soloGastos.body.summary.totalAmount).toBeCloseTo(esperadoGastos, 2);
    expect(soloGastos.body.summary.count).toBe(
      MONTOS.filter((_, i) => i % 2 === 1).length,
    );
  });

  it("el cursor recorre la lista sin repetir ni saltear", async () => {
    const primera = await traer({ limit: 3 });
    const segunda = await traer({ limit: 3, cursor: primera.body.pageInfo.nextCursor });

    const ids1 = primera.body.data.map((r: { id: string }) => r.id);
    const ids2 = segunda.body.data.map((r: { id: string }) => r.id);

    expect(ids1).toHaveLength(3);
    expect(ids2.length).toBeGreaterThan(0);
    // Ninguno repetido entre páginas.
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });
});

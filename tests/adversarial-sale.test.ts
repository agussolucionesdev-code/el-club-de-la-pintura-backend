/**
 * Tests adversariales de la venta: un cliente manipulado no puede fijar precios.
 *
 * El backend le creía al navegador tres cosas a la vez:
 *   · `unitPrice`   → se persistía como precio cobrado
 *   · `totalAmount` → nunca se contrastaba contra la suma de los ítems
 *   · `unitCost`    → se leía de un campo que el schema ni declara
 *
 * Juntas daban un agujero explotable: ítems por $100.000 con `totalAmount: 1`
 * cobraban $1 y descontaban el stock completo.
 *
 * Estos tests mandan payloads hostiles a propósito y verifican que el servidor
 * imponga sus propios números.
 */

import request from "supertest";
import bcrypt from "bcrypt";

import app from "../src/app";
import prisma from "../src/config/db";
import { testTerminalFor } from "./helpers/terminal";
import { generateTestToken } from "./helpers/auth";

describe("Ventas: el precio lo pone el servidor", () => {
  const runId = Date.now();
  const emailManager = `robot_adv_mgr_${runId}@elclub.com`;
  const emailEmployee = `robot_adv_emp_${runId}@elclub.com`;

  const RETAIL = 500;
  const COST = 300;

  let managerToken = "";
  let employeeToken = "";
  let managerId = 0;
  let employeeId = 0;
  let branchId = 0;
  let cashRegisterId = 0;
  let productId = 0;
  let sinCostoId = 0;

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `Sucursal Adv ${runId}`, location: "Mostrador" },
    });
    branchId = branch.id;

    const password = await bcrypt.hash("supersecretpassword", 10);
    const [manager, employee] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Encargado Adv ${runId}`,
          email: emailManager,
          password,
          role: "ENCARGADO",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Empleado Adv ${runId}`,
          email: emailEmployee,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
    ]);
    managerId = manager.id;
    employeeId = employee.id;

    const [product, sinCosto] = await Promise.all([
      prisma.product.create({
        data: {
          sku: `ADV-${runId}`,
          name: `Látex Adversarial ${runId}`,
          brand: "Robot",
          category: "Pruebas",
          costPrice: COST,
          retailPrice: RETAIL,
        },
      }),
      prisma.product.create({
        data: {
          sku: `ADV-SINCOSTO-${runId}`,
          name: `Sin costo cargado ${runId}`,
          brand: "Robot",
          category: "Pruebas",
          costPrice: null,
          retailPrice: RETAIL,
        },
      }),
    ]);
    productId = product.id;
    sinCostoId = sinCosto.id;

    await prisma.stock.createMany({
      data: [
        { productId, branchId, quantity: 10_000, minStock: 0 },
        { productId: sinCostoId, branchId, quantity: 1000, minStock: 0 },
      ],
    });

    const cashRegister = await prisma.cashRegister.create({
      data: { terminalId: await testTerminalFor(branchId), initialBalance: 100, status: "OPEN", userId: managerId, branchId },
    });
    cashRegisterId = cashRegister.id;

    managerToken = generateTestToken({ userId: managerId, role: "ENCARGADO", branchIds: [branchId] });
    employeeToken = generateTestToken({ userId: employeeId, role: "EMPLOYEE", branchIds: [branchId] });
  });

  afterAll(async () => {
    const sales = await prisma.sale.findMany({ where: { branchId }, select: { id: true } });
    const saleIds = sales.map((sale) => sale.id);
    await prisma.auditLog.deleteMany({ where: { branchId } });
    await prisma.internalReceipt.deleteMany({ where: { branchId } });
    await prisma.payment.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    await prisma.movement.deleteMany({ where: { branchId } });
    await prisma.cashRegister.deleteMany({ where: { id: cashRegisterId } });
    await prisma.stock.deleteMany({ where: { productId: { in: [productId, sinCostoId] } } });
    await prisma.product.deleteMany({ where: { id: { in: [productId, sinCostoId] } } });
    await prisma.user.deleteMany({ where: { email: { in: [emailManager, emailEmployee] } } });
    // El helper crea una terminal por sucursal; hay que borrarla ANTES
    // que la sucursal o la clave foránea lo impide.
    await prisma.terminal.deleteMany({ where: { code: { startsWith: "TEST-" } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  const sell = (body: object, token = managerToken) =>
    request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId, cashRegisterId, paymentMethod: "CASH", ...body });

  const stockActual = async (id = productId) =>
    (
      await prisma.stock.findUniqueOrThrow({
        where: { productId_branchId: { productId: id, branchId } },
      })
    ).quantity;

  // ── El agujero original ──────────────────────────────────────────────────

  it("ítems por $100.000 con totalAmount: 1 se RECHAZAN sin tocar nada", async () => {
    const antes = await stockActual();

    const res = await sell({
      totalAmount: 1,
      items: [{ productId, quantity: 200, unitPrice: 500, subtotal: 100_000 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TOTAL_MISMATCH");
    expect(res.body.authoritativeTotal).toBe(100_000);
    expect(res.body.expectedTotal).toBe(1);

    // El request rechazado no dejó NADA.
    expect(await stockActual()).toBe(antes);
    expect(await prisma.sale.count({ where: { totalAmount: 1 } })).toBe(0);
  });

  it("un unitPrice inflado por el cliente se ignora: manda el precio de lista", async () => {
    const res = await sell({
      totalAmount: RETAIL, // el cliente sabe el total real…
      items: [{ productId, quantity: 1, unitPrice: 999_999, subtotal: 999_999 }],
    });

    expect(res.status).toBe(201);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: res.body.data.id },
    });
    expect(Number(item.unitPrice)).toBe(RETAIL);
    expect(Number(item.subtotal)).toBe(RETAIL);
  });

  it("un unitPrice REBAJADO tampoco pasa: el total no cuadra y se rechaza", async () => {
    const res = await sell({
      totalAmount: 1,
      items: [{ productId, quantity: 1, unitPrice: 1, subtotal: 1 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TOTAL_MISMATCH");
  });

  it("un unitCost inyectado se descarta: el costo sale de la base", async () => {
    const res = await sell({
      totalAmount: RETAIL,
      items: [{ productId, quantity: 1, unitCost: 0.01, unitPrice: RETAIL, subtotal: RETAIL }],
    });

    expect(res.status).toBe(201);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: res.body.data.id },
    });
    expect(Number(item.unitCost)).toBe(COST);
  });

  // ── Costo desconocido ≠ costo cero ───────────────────────────────────────

  it("un producto sin costo cargado guarda unitCost NULL, no 0", async () => {
    const res = await sell({
      totalAmount: RETAIL,
      items: [{ productId: sinCostoId, quantity: 1 }],
    });

    expect(res.status).toBe(201);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: res.body.data.id },
    });
    // NULL = "no sabemos". Cero diría "no costó nada" e inventaría 100% de margen.
    expect(item.unitCost).toBeNull();
  });

  // ── Descuentos y precios excepcionales ───────────────────────────────────

  it("un descuento de línea se aplica sobre el precio de lista del servidor", async () => {
    const res = await sell({
      totalAmount: 450, // 500 - 10%
      items: [{ productId, quantity: 1, discountPct: 10 }],
    });

    expect(res.status).toBe(201);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: res.body.data.id },
    });
    expect(Number(item.listPrice)).toBe(RETAIL);
    expect(Number(item.unitPrice)).toBe(450);
    expect(Number(item.discountPct)).toBe(10);
  });

  it("un EMPLEADO no puede pasarse del tope de descuento de su rol", async () => {
    const res = await sell(
      { totalAmount: 250, items: [{ productId, quantity: 1, discountPct: 50 }] },
      employeeToken,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/permite hasta 15%/u);
  });

  it("un EMPLEADO no puede fijar un precio excepcional", async () => {
    const res = await sell(
      { totalAmount: 1, items: [{ productId, quantity: 1, priceOverride: 1 }] },
      employeeToken,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/permiso para fijar un precio excepcional/u);
  });

  it("un ENCARGADO sí puede, y queda auditado", async () => {
    const res = await sell({
      totalAmount: 350,
      items: [{ productId, quantity: 1, priceOverride: 350 }],
    });

    expect(res.status).toBe(201);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: res.body.data.id },
    });
    expect(Number(item.unitPrice)).toBe(350);
    expect(Number(item.listPrice)).toBe(RETAIL);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "SALE_PRICE_OVERRIDE", entityId: String(res.body.data.id) },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(managerId);
  });

  // ── Cantidades ───────────────────────────────────────────────────────────

  it("una cantidad fraccionaria se rechaza en la validación del schema", async () => {
    const res = await sell({
      totalAmount: 1250,
      items: [{ productId, quantity: 2.5 }],
    });
    expect(res.status).toBe(400);
  });

  it("líneas duplicadas del mismo producto se suman ANTES de tocar stock", async () => {
    const res = await sell({
      totalAmount: RETAIL * 3,
      items: [
        { productId, quantity: 1 },
        { productId, quantity: 2 },
      ],
    });

    expect(res.status).toBe(201);
    const items = await prisma.saleItem.findMany({ where: { saleId: res.body.data.id } });
    // Una sola línea de 3, no dos que se validan por separado contra el stock.
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(3);
  });

  it("dos líneas del mismo producto con distinto descuento NO se fusionan", async () => {
    const res = await sell({
      totalAmount: RETAIL + 450, // una entera + una con 10%
      items: [
        { productId, quantity: 1 },
        { productId, quantity: 1, discountPct: 10 },
      ],
    });

    expect(res.status).toBe(201);
    const items = await prisma.saleItem.findMany({ where: { saleId: res.body.data.id } });
    // Trato comercial distinto = líneas distintas. Es deliberado del vendedor.
    expect(items).toHaveLength(2);
  });

  // ── Efectivo y vuelto ────────────────────────────────────────────────────

  it("el vuelto se calcula contra el COMPONENTE en efectivo, no contra el total", async () => {
    // $10.000: $6.000 tarjeta + $4.000 efectivo. Entrega $5.000 → vuelto $1.000.
    const res = await sell({
      paymentMethod: "MIXED",
      totalAmount: 10_000,
      cashReceived: 5000,
      payments: [
        { paymentMethod: "DEBIT", amount: 6000 },
        { paymentMethod: "CASH", amount: 4000 },
      ],
      items: [{ productId, quantity: 20 }],
    });

    expect(res.status).toBe(201);
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(Number(sale.cashReceived)).toBe(5000);
    // Contra el total daría -5000. Contra el componente en efectivo, 1000.
    expect(Number(sale.changeGiven)).toBe(1000);
  });

  it("un efectivo que no cubre la parte en efectivo se rechaza", async () => {
    const res = await sell({
      totalAmount: RETAIL,
      cashReceived: 100,
      items: [{ productId, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no cubre la parte en efectivo/u);
  });

  // ── Contrato real del POS ────────────────────────────────────────────────
  // Estos payloads replican EXACTAMENTE lo que arma `buildPayload()` del
  // frontend tras el cambio de contrato. Es el riesgo real de esta fase: que
  // backend y frontend queden hablando idiomas distintos y el mostrador se
  // coma un 409 en cada venta.

  it("payload del POS: venta simple en efectivo", async () => {
    const res = await sell({
      customerId: null,
      totalAmount: RETAIL * 2,
      cashReceived: 2000,
      paymentMethod: "CASH",
      payments: undefined,
      pickedUpBy: undefined,
      note: undefined,
      status: "PAID",
      items: [{ productId, quantity: 2, discountPct: null, priceOverride: null }],
    });

    expect(res.status).toBe(201);
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: res.body.data.id } });
    expect(Number(sale.totalAmount)).toBe(1000);
    expect(Number(sale.changeGiven)).toBe(1000); // entregó 2000, la venta es 1000
  });

  it("payload del POS: línea con descuento porcentual", async () => {
    const res = await sell({
      totalAmount: 450,
      items: [{ productId, quantity: 1, discountPct: 10, priceOverride: null }],
    });
    expect(res.status).toBe(201);
  });

  it("payload del POS: línea con precio excepcional POR ENCIMA de la lista", async () => {
    // El caso que el contrato viejo rompía: como calculaba un "descuento
    // efectivo", un override hacia arriba daba 0% y el servidor cobraba lista.
    const res = await sell({
      totalAmount: 800,
      items: [{ productId, quantity: 1, discountPct: null, priceOverride: 800 }],
    });

    expect(res.status).toBe(201);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: res.body.data.id },
    });
    expect(Number(item.unitPrice)).toBe(800);
    expect(Number(item.listPrice)).toBe(RETAIL);
  });

  // ── Catálogo ─────────────────────────────────────────────────────────────

  it("no se puede vender un producto inexistente", async () => {
    const res = await sell({
      totalAmount: 100,
      items: [{ productId: 999_999_999, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no existe en el catálogo/u);
  });
});

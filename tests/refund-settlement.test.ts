/**
 * Liquidación de reintegros: por dónde vuelve la plata en una devolución.
 *
 * El agujero que cierra: una devolución de venta YA PAGADA restauraba el stock
 * y NO registraba ningún movimiento de dinero. El cajón quedaba esperando más
 * efectivo del que tenía.
 *
 * Y la trampa opuesta: "crear siempre un Payment negativo" habría sido igual de
 * falso. Una devolución contra deuda impaga no saca un peso del cajón, y una
 * reversa de tarjeta ocurre en el Posnet, fuera de este sistema.
 */

import request from "supertest";
import bcrypt from "bcrypt";
import { RefundSettlementKind } from "@prisma/client";

import app from "../src/app";
import prisma from "../src/config/db";
import { testTerminalFor } from "./helpers/terminal";
import { generateTestToken } from "./helpers/auth";
import { planRefundSettlements } from "../src/utils/refund.utils";
import { toDecimal } from "../src/utils/pricing.utils";

describe("Liquidación de reintegros", () => {
  const runId = Date.now();
  const email = `robot_refund_${runId}@elclub.com`;
  const RETAIL = 1000;

  let token = "";
  let userId = 0;
  let branchId = 0;
  let cashRegisterId = 0;
  let productId = 0;
  let customerId = 0;

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `Sucursal Refund ${runId}`, location: "Mostrador" },
    });
    branchId = branch.id;

    const user = await prisma.user.create({
      data: {
        name: `Robot Refund ${runId}`,
        email,
        password: await bcrypt.hash("supersecretpassword", 10),
        role: "ENCARGADO",
        branches: { connect: [{ id: branchId }] },
      },
    });
    userId = user.id;

    const product = await prisma.product.create({
      data: {
        sku: `REF-${runId}`,
        name: `Producto Refund ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        costPrice: 400,
        retailPrice: RETAIL,
      },
    });
    productId = product.id;

    await prisma.stock.create({ data: { productId, branchId, quantity: 500, minStock: 0 } });

    const customer = await prisma.customer.create({
      data: { name: `Cliente Refund ${runId}`, type: "CONSUMER", creditLimit: 0 },
    });
    customerId = customer.id;

    // Turno con efectivo inicial holgado, para que los reintegros en efectivo
    // tengan de dónde salir.
    const cashRegister = await prisma.cashRegister.create({
      data: { terminalId: await testTerminalFor(branchId), initialBalance: 100_000, status: "OPEN", userId, branchId },
    });
    cashRegisterId = cashRegister.id;

    token = generateTestToken({ userId, role: "ENCARGADO", branchIds: [branchId] });
  });

  afterAll(async () => {
    const sales = await prisma.sale.findMany({ where: { branchId }, select: { id: true } });
    const saleIds = sales.map((s) => s.id);
    const devoluciones = await prisma.return.findMany({ where: { branchId }, select: { id: true } });

    await prisma.refundSettlement.deleteMany({
      where: { returnId: { in: devoluciones.map((d) => d.id) } },
    });
    await prisma.return.deleteMany({ where: { branchId } });
    await prisma.internalReceipt.deleteMany({ where: { branchId } });
    await prisma.payment.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    await prisma.movement.deleteMany({ where: { branchId } });
    await prisma.cashRegister.deleteMany({ where: { id: cashRegisterId } });
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.customer.deleteMany({ where: { id: customerId } });
    await prisma.user.deleteMany({ where: { email } });
    // El helper crea una terminal por sucursal; hay que borrarla ANTES
    // que la sucursal o la clave foránea lo impide.
    await prisma.terminal.deleteMany({ where: { code: { startsWith: "TEST-" } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  const vender = (body: object) =>
    request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${token}`)
      .send({ branchId, cashRegisterId, ...body });

  /** La devolución referencia la LÍNEA de la venta, no el producto: una misma
   *  venta puede tener dos líneas del mismo producto a precios distintos. */
  const devolver = async (saleId: number, quantity: number) => {
    const linea = await prisma.saleItem.findFirstOrThrow({ where: { saleId } });
    return request(app)
      .post(`/api/sales/${saleId}/return`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        reason: "Producto fallado, devolución de prueba",
        items: [{ saleItemId: linea.id, quantity }],
      });
  };

  const liquidacionesDe = async (saleId: number) => {
    const dev = await prisma.return.findFirstOrThrow({
      where: { saleId },
      orderBy: { id: "desc" },
      include: { settlements: true },
    });
    return dev.settlements;
  };

  // ── El plan, como función pura ───────────────────────────────────────────

  describe("cómo se arma el plan", () => {
    it("primero cancela contra la deuda impaga: eso no mueve el cajón", () => {
      const plan = planRefundSettlements(toDecimal(1000), toDecimal(1000), []);
      expect(plan).toHaveLength(1);
      expect(plan[0]?.kind).toBe(RefundSettlementKind.CUSTOMER_DEBT_CREDIT);
      expect(plan[0]?.amount.toNumber()).toBe(1000);
    });

    it("lo ya cobrado vuelve por donde entró", () => {
      const plan = planRefundSettlements(toDecimal(1000), toDecimal(0), [
        { paymentMethod: "CASH", amount: 1000 },
      ]);
      expect(plan[0]?.kind).toBe(RefundSettlementKind.CASH);
    });

    it("una venta con tarjeta se reversa, no sale del cajón", () => {
      const plan = planRefundSettlements(toDecimal(1000), toDecimal(0), [
        { paymentMethod: "DEBIT", amount: 1000 },
      ]);
      expect(plan[0]?.kind).toBe(RefundSettlementKind.CARD_REVERSAL);
    });

    it("un pago mixto se reparte entre efectivo y reversa", () => {
      const plan = planRefundSettlements(toDecimal(1000), toDecimal(0), [
        { paymentMethod: "CASH", amount: 400 },
        { paymentMethod: "DEBIT", amount: 600 },
      ]);
      const porTipo = Object.fromEntries(plan.map((p) => [p.kind, p.amount.toNumber()]));
      expect(porTipo[RefundSettlementKind.CASH]).toBe(400);
      expect(porTipo[RefundSettlementKind.CARD_REVERSAL]).toBe(600);
    });

    it("venta PARCIAL: parte contra deuda, parte en efectivo", () => {
      // Total 1000: pagó 400 en efectivo, debe 600. Se devuelve todo.
      const plan = planRefundSettlements(toDecimal(1000), toDecimal(600), [
        { paymentMethod: "CASH", amount: 400 },
      ]);
      const porTipo = Object.fromEntries(plan.map((p) => [p.kind, p.amount.toNumber()]));
      expect(porTipo[RefundSettlementKind.CUSTOMER_DEBT_CREDIT]).toBe(600);
      expect(porTipo[RefundSettlementKind.CASH]).toBe(400);
    });

    it("los reintegros previos (pagos negativos) no se devuelven dos veces", () => {
      const plan = planRefundSettlements(toDecimal(1000), toDecimal(0), [
        { paymentMethod: "CASH", amount: 1000 },
        { paymentMethod: "CASH", amount: -600 }, // ya se devolvieron 600
      ]);
      const efectivo = plan.find((p) => p.kind === RefundSettlementKind.CASH);
      expect(efectivo?.amount.toNumber()).toBe(400);
      // El resto queda reconocido, no se pierde ni se inventa.
      expect(plan.some((p) => p.kind === RefundSettlementKind.PENDING_REIMBURSEMENT)).toBe(true);
    });

    it("la suma del plan siempre iguala el monto a devolver", () => {
      const plan = planRefundSettlements(toDecimal(1000), toDecimal(300), [
        { paymentMethod: "CASH", amount: 200 },
        { paymentMethod: "TRANSFER", amount: 500 },
      ]);
      const suma = plan.reduce((s, p) => s + p.amount.toNumber(), 0);
      expect(suma).toBe(1000);
    });
  });

  // ── End to end ───────────────────────────────────────────────────────────

  it("devolución de venta pagada en EFECTIVO: sale del cajón y baja el arqueo", async () => {
    const venta = await vender({
      paymentMethod: "CASH",
      totalAmount: RETAIL * 2,
      items: [{ productId, quantity: 2 }],
    });
    expect(venta.status).toBe(201);
    const saleId = venta.body.data.id;

    const dev = await devolver(saleId, 1);
    expect(dev.status).toBe(201);

    const liquidaciones = await liquidacionesDe(saleId);
    expect(liquidaciones).toHaveLength(1);
    expect(liquidaciones[0]?.kind).toBe(RefundSettlementKind.CASH);
    expect(Number(liquidaciones[0]?.amount)).toBe(RETAIL);

    // Lo que hace visible el reintegro en el arqueo: un Payment negativo.
    expect(liquidaciones[0]?.paymentId).not.toBeNull();
    const devolucionPago = await prisma.payment.findUniqueOrThrow({
      where: { id: liquidaciones[0]!.paymentId! },
    });
    expect(Number(devolucionPago.amount)).toBe(-RETAIL);
    expect(devolucionPago.cashRegisterId).toBe(cashRegisterId);
  });

  it("devolución contra DEUDA IMPAGA: baja la deuda y NO toca el cajón", async () => {
    const venta = await vender({
      paymentMethod: "CREDIT_ACCOUNT",
      customerId,
      pickedUpBy: "Juan Retira DNI 30111222",
      totalAmount: RETAIL * 2,
      items: [{ productId, quantity: 2 }],
    });
    expect(venta.status).toBe(201);
    const saleId = venta.body.data.id;

    const pagosAntes = await prisma.payment.count({ where: { cashRegisterId } });

    const dev = await devolver(saleId, 1);
    expect(dev.status).toBe(201);

    const liquidaciones = await liquidacionesDe(saleId);
    expect(liquidaciones).toHaveLength(1);
    expect(liquidaciones[0]?.kind).toBe(RefundSettlementKind.CUSTOMER_DEBT_CREDIT);
    // Ningún Payment: no salió un peso del cajón, sólo bajó lo que se debe.
    expect(liquidaciones[0]?.paymentId).toBeNull();
    expect(await prisma.payment.count({ where: { cashRegisterId } })).toBe(pagosAntes);

    const venta2 = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } });
    expect(Number(venta2.balance)).toBe(RETAIL);
  });

  it("devolución de venta con TARJETA: se registra la reversa, no sale efectivo", async () => {
    const venta = await vender({
      paymentMethod: "DEBIT",
      totalAmount: RETAIL,
      cardBrand: "VISA",
      cardLast4: "4242",
      items: [{ productId, quantity: 1 }],
    });
    expect(venta.status).toBe(201);
    const saleId = venta.body.data.id;

    const dev = await devolver(saleId, 1);
    expect(dev.status).toBe(201);

    const liquidaciones = await liquidacionesDe(saleId);
    expect(liquidaciones[0]?.kind).toBe(RefundSettlementKind.CARD_REVERSAL);
    // La reversa la hace el Posnet. Sacarla del cajón le quitaría efectivo real
    // al negocio por una plata que nunca estuvo ahí.
    expect(liquidaciones[0]?.paymentId).toBeNull();
    expect(liquidaciones[0]?.cashRegisterId).toBeNull();
  });

  it("pago MIXTO: se reparte entre efectivo y reversa, y sólo el efectivo mueve caja", async () => {
    const venta = await vender({
      paymentMethod: "MIXED",
      totalAmount: RETAIL * 2,
      payments: [
        { paymentMethod: "CASH", amount: 800 },
        { paymentMethod: "DEBIT", amount: 1200 },
      ],
      items: [{ productId, quantity: 2 }],
    });
    expect(venta.status).toBe(201);
    const saleId = venta.body.data.id;

    const dev = await devolver(saleId, 2); // se devuelve todo
    expect(dev.status).toBe(201);

    const liquidaciones = await liquidacionesDe(saleId);
    const porTipo = Object.fromEntries(liquidaciones.map((l) => [l.kind, Number(l.amount)]));

    expect(porTipo[RefundSettlementKind.CASH]).toBe(800);
    expect(porTipo[RefundSettlementKind.CARD_REVERSAL]).toBe(1200);

    const conPago = liquidaciones.filter((l) => l.paymentId !== null);
    expect(conPago).toHaveLength(1);
    expect(conPago[0]?.kind).toBe(RefundSettlementKind.CASH);
  });

  it("el stock se restaura UNA sola vez por devolución", async () => {
    const antes = (
      await prisma.stock.findUniqueOrThrow({
        where: { productId_branchId: { productId, branchId } },
      })
    ).quantity;

    const venta = await vender({
      paymentMethod: "CASH",
      totalAmount: RETAIL * 3,
      items: [{ productId, quantity: 3 }],
    });
    const saleId = venta.body.data.id;

    const despuesVenta = (
      await prisma.stock.findUniqueOrThrow({
        where: { productId_branchId: { productId, branchId } },
      })
    ).quantity;
    expect(despuesVenta).toBe(antes - 3);

    await devolver(saleId, 2);

    const despuesDev = (
      await prisma.stock.findUniqueOrThrow({
        where: { productId_branchId: { productId, branchId } },
      })
    ).quantity;
    expect(despuesDev).toBe(antes - 1); // vendió 3, devolvió 2
  });
});

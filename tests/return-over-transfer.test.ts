/**
 * Devolución sobre mercadería YA TRASLADADA al libro del personal.
 *
 * ── El bug que esto defiende ────────────────────────────────────────────────
 *
 * Si una venta trasladada recibe después una devolución, `balance` bajaba pero
 * el monto trasladado quedaba fijo. La resta daba una cuenta por cobrar
 * NEGATIVA: el sistema creía que el cliente tenía saldo a favor por mercadería
 * que en realidad se le había cargado a un empleado.
 *
 * La aritmética está probada en `staff-ledger.test.ts` con un test de
 * propiedad. Esto verifica el camino COMPLETO contra la base: que la devolución
 * descargue al empleado, que lo haga con un contra-asiento y no editando, y que
 * el stock vuelva una sola vez.
 */

import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import { testTerminalFor } from "./helpers/terminal";

describe("Devolución sobre una venta trasladada", () => {
  const runId = Date.now();
  let branchId = 0;
  let adminId = 0;
  let empleadoId = 0;
  let adminToken = "";
  let clienteInternoId = 0;
  let productId = 0;
  let cashRegisterId = 0;
  let saleId = 0;
  let saleItemId = 0;
  let linkId = 0;

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `LegRet ${runId}`, location: "A" },
    });
    branchId = branch.id;

    const password = await bcrypt.hash("supersecretpassword", 10);
    const [admin, emp] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Admin Ret ${runId}`,
          email: `legret_admin_${runId}@x.com`,
          password,
          role: "ADMIN",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Pedro Ret ${runId}`,
          email: `legret_emp_${runId}@x.com`,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
    ]);
    adminId = admin.id;
    empleadoId = emp.id;
    adminToken = generateTestToken({
      userId: adminId,
      role: "ADMIN",
      branchIds: [branchId],
    });

    const interno = await prisma.customer.create({
      data: { name: `Pedro viejo ${runId}`, type: "INTERNAL" },
    });
    clienteInternoId = interno.id;

    const prod = await prisma.product.create({
      data: {
        sku: `LEGRET-${runId}`,
        name: `Producto Ret ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        retailPrice: 1000,
        costPrice: 400,
      },
    });
    productId = prod.id;
    await prisma.stock.create({
      data: { productId, branchId, quantity: 100 },
    });

    const terminalId = await testTerminalFor(branchId);
    const caja = await prisma.cashRegister.create({
      data: { branchId, terminalId, userId: adminId, initialBalance: 0, status: "OPEN" },
    });
    cashRegisterId = caja.id;

    // Una venta vieja del sistema anterior: $10.000, todo a deber.
    const venta = await prisma.sale.create({
      data: {
        totalAmount: 10000,
        paymentMethod: "CREDIT_ACCOUNT",
        status: "PENDING",
        balance: 10000,
        customerId: clienteInternoId,
        branchId,
        userId: adminId,
        sellerId: adminId,
        cashierId: adminId,
        cashRegisterId,
        items: {
          create: [
            {
              productId,
              quantity: 10,
              unitPrice: 1000,
              subtotal: 10000,
              unitCost: 400,
            },
          ],
        },
      },
    });
    saleId = venta.id;

    const linea = await prisma.saleItem.findFirst({ where: { saleId } });
    saleItemId = linea!.id;

    // Se vincula a Pedro y se traslada la deuda entera.
    const propuesta = await request(app)
      .post("/api/legacy-links")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        legacyCustomerId: clienteInternoId,
        userId: empleadoId,
        reason: "Cuenta vieja de Pedro, confirmado con él",
      });
    linkId = propuesta.body.data.id;

    await request(app)
      .post(`/api/legacy-links/${linkId}/confirm`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ reason: "Traslado de la cuenta interna de Pedro" });
  });

  afterAll(async () => {
    await prisma.refundSettlement.deleteMany({ where: { return: { branchId } } });
    await prisma.return.deleteMany({ where: { branchId } });
    await prisma.legacySaleTransfer.deleteMany({ where: { saleId } });
    await prisma.staffLedgerEntry.deleteMany({
      where: { staffAccount: { userId: empleadoId } },
    });
    await prisma.staffAccountLegacyLink.deleteMany({
      where: { legacyCustomerId: clienteInternoId },
    });
    await prisma.staffAccount.deleteMany({ where: { userId: empleadoId } });
    await prisma.internalReceipt.deleteMany({ where: { branchId } });
    await prisma.movement.deleteMany({ where: { branchId } });
    await prisma.saleItem.deleteMany({ where: { saleId } });
    await prisma.auditLog.deleteMany({ where: { branchId } });
    await prisma.payment.deleteMany({ where: { branchId } });
    await prisma.sale.deleteMany({ where: { branchId } });
    await prisma.cashRegister.deleteMany({ where: { branchId } });
    await prisma.posOperatorSession.deleteMany({
      where: { userId: { in: [adminId, empleadoId] } },
    });
    await prisma.terminal.deleteMany({ where: { branchId } });
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.customer.deleteMany({ where: { id: clienteInternoId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, empleadoId] } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  it("el traslado dejó la deuda en el libro de Pedro", async () => {
    const cuenta = await prisma.staffAccount.findUnique({
      where: { userId: empleadoId },
      include: { entries: { select: { debit: true, credit: true } } },
    });
    const saldo = cuenta!.entries.reduce(
      (s, e) => s + Number(e.debit) - Number(e.credit),
      0,
    );
    expect(saldo).toBe(10000);
  });

  it("🔒 la devolución DESCARGA AL EMPLEADO, no al cliente", async () => {
    // Se devuelven 3 de las 10 unidades: $3.000.
    const res = await request(app)
      .post(`/api/sales/${saleId}/return`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        reason: "Se devolvieron tres latas sin abrir",
        items: [{ saleItemId, quantity: 3 }],
      });

    expect(res.status).toBeLessThan(400);

    const cuenta = await prisma.staffAccount.findUnique({
      where: { userId: empleadoId },
      include: { entries: true },
    });
    const saldo = cuenta!.entries.reduce(
      (s, e) => s + Number(e.debit) - Number(e.credit),
      0,
    );

    // La deuda de Pedro bajó $3.000: la mercadería se le había cargado a él,
    // así que devolverla lo descarga a él.
    expect(saldo).toBe(7000);

    // Y se hizo AGREGANDO un contra-asiento, no editando el de apertura.
    const compensacion = cuenta!.entries.find(
      (e) => e.type === "TRANSFER_REVERSAL" && e.sourceType === "Return",
    );
    expect(compensacion).toBeDefined();
    expect(Number(compensacion!.credit)).toBe(3000);
    expect(compensacion!.reversalOfId).not.toBeNull();

    // El asiento de apertura sigue intacto.
    const apertura = cuenta!.entries.find((e) => e.type === "OPENING_BALANCE");
    expect(Number(apertura!.debit)).toBe(10000);
  });

  it("🔒 la cuenta por cobrar NUNCA queda negativa", async () => {
    const venta = await prisma.sale.findUnique({ where: { id: saleId } });

    const trasladadoVivo =
      Number(venta!.transferredToStaffLedger) - Number(venta!.transferReversed);
    const porCobrar = Number(venta!.balance) - trasladadoVivo;

    // Éste es el bug original: `balance` bajaba y el trasladado quedaba fijo.
    expect(porCobrar).toBeGreaterThanOrEqual(0);
    expect(trasladadoVivo).toBe(7000);
  });

  it("el ciclo queda parcialmente revertido y sigue vivo", async () => {
    const ciclo = await prisma.legacySaleTransfer.findFirst({ where: { saleId } });
    expect(ciclo!.status).toBe("PARTIALLY_REVERSED");
    expect(Number(ciclo!.reversedAmount)).toBe(3000);
    // El trasladado original NO se toca: es inmutable.
    expect(Number(ciclo!.transferredAmount)).toBe(10000);
  });

  it("el stock vuelve UNA sola vez", async () => {
    const stock = await prisma.stock.findFirst({ where: { productId, branchId } });
    // La venta se creó como fixture sin descontar stock, así que 100 + 3.
    // Lo que importa es que sumó exactamente una vez.
    expect(stock!.quantity).toBe(103);
  });

  it("🔒 devolver el resto deja el ciclo cerrado y el libro en cero", async () => {
    const res = await request(app)
      .post(`/api/sales/${saleId}/return`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        reason: "Devolvió el resto",
        items: [{ saleItemId, quantity: 7 }],
      });
    expect(res.status).toBeLessThan(400);

    const cuenta = await prisma.staffAccount.findUnique({
      where: { userId: empleadoId },
      include: { entries: { select: { debit: true, credit: true } } },
    });
    const saldo = cuenta!.entries.reduce(
      (s, e) => s + Number(e.debit) - Number(e.credit),
      0,
    );
    expect(saldo).toBe(0);

    const ciclo = await prisma.legacySaleTransfer.findFirst({ where: { saleId } });
    expect(ciclo!.status).toBe("FULLY_REVERSED");

    const venta = await prisma.sale.findUnique({ where: { id: saleId } });
    const porCobrar =
      Number(venta!.balance) -
      (Number(venta!.transferredToStaffLedger) - Number(venta!.transferReversed));
    expect(porCobrar).toBeGreaterThanOrEqual(0);
  });
});

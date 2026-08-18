/**
 * Cuentas del personal, de punta a punta.
 *
 * Lo que estos tests defienden:
 *
 *   · Que un consumo de la EMPRESA no le genere deuda a nadie.
 *   · Que sólo el efectivo toque la caja física.
 *   · Que un empleado no vea el saldo de su compañero.
 *   · Que el libro sea inmutable: se corrige agregando, no editando.
 */

import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import { testTerminalFor } from "./helpers/terminal";

describe("Cuentas del personal", () => {
  const runId = Date.now();
  let branchId = 0;
  let otraSucursalId = 0;
  let adminId = 0;
  let empleadoId = 0;
  let otroEmpleadoId = 0;
  let adminToken = "";
  let empleadoToken = "";
  let otroToken = "";
  let productId = 0;
  let productoSinCostoId = 0;
  let cashRegisterId = 0;

  const consumo = (token: string, body: Record<string, unknown>) =>
    request(app)
      .post("/api/internal-consumptions")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `cons-${runId}-${Math.random().toString(36).slice(2, 12)}`)
      .send(body);

  beforeAll(async () => {
    const [b1, b2] = await Promise.all([
      prisma.branch.create({ data: { name: `Staff ${runId}`, location: "A" } }),
      prisma.branch.create({ data: { name: `Staff B ${runId}`, location: "B" } }),
    ]);
    branchId = b1.id;
    otraSucursalId = b2.id;

    const password = await bcrypt.hash("supersecretpassword", 10);
    const [admin, emp, otro] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Admin Staff ${runId}`,
          email: `staff_admin_${runId}@x.com`,
          password,
          role: "ADMIN",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Empleado Staff ${runId}`,
          email: `staff_emp_${runId}@x.com`,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Otro Staff ${runId}`,
          email: `staff_otro_${runId}@x.com`,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
    ]);
    adminId = admin.id;
    empleadoId = emp.id;
    otroEmpleadoId = otro.id;

    adminToken = generateTestToken({ userId: adminId, role: "ADMIN", branchIds: [branchId] });
    empleadoToken = generateTestToken({
      userId: empleadoId,
      role: "EMPLOYEE",
      branchIds: [branchId],
    });
    otroToken = generateTestToken({
      userId: otroEmpleadoId,
      role: "EMPLOYEE",
      branchIds: [branchId],
    });

    const [prod, sinCosto] = await Promise.all([
      prisma.product.create({
        data: {
          sku: `STAFF-${runId}`,
          name: `Pincel Staff ${runId}`,
          brand: "Robot",
          category: "Pruebas",
          retailPrice: 10000,
          costPrice: 4000,
        },
      }),
      prisma.product.create({
        data: {
          sku: `STAFF-SC-${runId}`,
          name: `Sin costo ${runId}`,
          brand: "Robot",
          category: "Pruebas",
          retailPrice: 5000,
          costPrice: null,
        },
      }),
    ]);
    productId = prod.id;
    productoSinCostoId = sinCosto.id;

    await prisma.stock.createMany({
      data: [
        { productId, branchId, quantity: 500 },
        { productId: productoSinCostoId, branchId, quantity: 500 },
      ],
    });

    const terminalId = await testTerminalFor(branchId);
    const caja = await prisma.cashRegister.create({
      data: { branchId, terminalId, userId: adminId, initialBalance: 10000, status: "OPEN" },
    });
    cashRegisterId = caja.id;
  });

  afterAll(async () => {
    const users = [adminId, empleadoId, otroEmpleadoId];
    await prisma.staffLedgerEntry.deleteMany({
      where: { staffAccount: { userId: { in: users } } },
    });
    await prisma.staffPaymentSettlement.deleteMany({
      where: { staffAccount: { userId: { in: users } } },
    });
    await prisma.internalConsumptionItem.deleteMany({
      where: { consumption: { branchId } },
    });
    await prisma.internalConsumption.deleteMany({ where: { branchId } });
    await prisma.staffAccount.deleteMany({ where: { userId: { in: users } } });
    await prisma.cashMovement.deleteMany({ where: { branchId } });
    await prisma.auditLog.deleteMany({ where: { branchId } });
    await prisma.movement.deleteMany({ where: { branchId } });
    await prisma.idempotencyRecord.deleteMany({
      where: { key: { startsWith: `cons-${runId}` } },
    });
    await prisma.cashRegister.deleteMany({ where: { branchId } });
    await prisma.posOperatorSession.deleteMany({ where: { userId: { in: users } } });
    await prisma.terminal.deleteMany({ where: { branchId } });
    await prisma.stock.deleteMany({
      where: { productId: { in: [productId, productoSinCostoId] } },
    });
    await prisma.product.deleteMany({
      where: { id: { in: [productId, productoSinCostoId] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otraSucursalId] } } });
    await prisma.$disconnect();
  });

  // ══════════════════════════════════════════════════════════════════════
  // LAS DOS CLASES
  // ══════════════════════════════════════════════════════════════════════

  describe("consumo del personal vs uso de la empresa", () => {
    it("el consumo de un empleado genera deuda y descuenta stock", async () => {
      const antes = await prisma.stock.findFirst({ where: { productId, branchId } });

      const res = await consumo(empleadoToken, {
        kind: "EMPLOYEE_PERSONAL",
        branchId,
        userId: empleadoId,
        pricePolicy: "RETAIL",
        items: [{ productId, quantity: 2 }],
      });

      expect(res.status).toBe(201);
      expect(res.body.data.createdDebt).toBe(true);
      expect(res.body.data.totalAmount).toBe(20000);

      const despues = await prisma.stock.findFirst({ where: { productId, branchId } });
      // La mercadería salió del depósito: el inventario tiene que decirlo, sin
      // importar por qué salió.
      expect(despues!.quantity).toBe(antes!.quantity - 2);

      const cuenta = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
        include: { entries: true },
      });
      expect(cuenta).not.toBeNull();
      expect(Number(cuenta!.entries[0]!.debit)).toBe(20000);
    });

    it("🔒 el uso de la EMPRESA descuenta stock pero NO le debe nadie", async () => {
      const antes = await prisma.stock.findFirst({ where: { productId, branchId } });

      const res = await consumo(adminToken, {
        kind: "COMPANY_USE",
        branchId,
        purpose: "Pintar el depósito",
        pricePolicy: "RETAIL",
        items: [{ productId, quantity: 3 }],
      });

      expect(res.status).toBe(201);
      expect(res.body.data.createdDebt).toBe(false);
      expect(res.body.data.staffAccountId).toBeNull();

      const despues = await prisma.stock.findFirst({ where: { productId, branchId } });
      expect(despues!.quantity).toBe(antes!.quantity - 3);

      // Y esto es lo que importa: ninguna cuenta se movió.
      const consumos = await prisma.internalConsumption.findFirst({
        where: { id: res.body.data.id },
      });
      expect(consumos!.staffAccountId).toBeNull();

      const asientos = await prisma.staffLedgerEntry.findMany({
        where: { sourceType: "InternalConsumption", sourceId: res.body.data.id },
      });
      expect(asientos).toHaveLength(0);
    });

    it("un uso de la empresa sin decir para qué se rechaza", async () => {
      const res = await consumo(adminToken, {
        kind: "COMPANY_USE",
        branchId,
        pricePolicy: "RETAIL",
        items: [{ productId, quantity: 1 }],
      });
      expect(res.status).toBe(400);
    });

    it("un consumo personal sin decir de quién se rechaza", async () => {
      const res = await consumo(adminToken, {
        kind: "EMPLOYEE_PERSONAL",
        branchId,
        pricePolicy: "RETAIL",
        items: [{ productId, quantity: 1 }],
      });
      expect(res.status).toBe(400);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // PRECIO
  // ══════════════════════════════════════════════════════════════════════

  describe("🔒 política de precio", () => {
    it("un empleado NO puede cobrarse al costo por su cuenta", async () => {
      // Sería un descuento que nadie autorizó.
      const res = await consumo(empleadoToken, {
        kind: "EMPLOYEE_PERSONAL",
        branchId,
        userId: empleadoId,
        pricePolicy: "COST",
        items: [{ productId, quantity: 1 }],
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("CAPABILITY_DENIED");
    });

    it("un empleado no puede cargarle mercadería a OTRO", async () => {
      const res = await consumo(empleadoToken, {
        kind: "EMPLOYEE_PERSONAL",
        branchId,
        userId: otroEmpleadoId,
        pricePolicy: "RETAIL",
        items: [{ productId, quantity: 1 }],
      });
      expect(res.status).toBe(403);
    });

    it("el admin sí puede aplicar precio al costo, y queda congelado", async () => {
      const res = await consumo(adminToken, {
        kind: "EMPLOYEE_PERSONAL",
        branchId,
        userId: otroEmpleadoId,
        pricePolicy: "COST",
        items: [{ productId, quantity: 1 }],
      });
      expect(res.status).toBe(201);
      expect(res.body.data.totalAmount).toBe(4000); // el costo, no los 10.000

      const registro = await prisma.internalConsumption.findUnique({
        where: { id: res.body.data.id },
      });
      // La política queda escrita: seis meses después se puede responder por qué.
      expect(registro!.pricePolicy).toBe("COST");
    });

    it("🔒 sin costo cargado, el precio al costo NO cae a cero", async () => {
      // Cargarle $0 a alguien por un vacío de datos sería regalarle mercadería.
      const res = await consumo(adminToken, {
        kind: "EMPLOYEE_PERSONAL",
        branchId,
        userId: otroEmpleadoId,
        pricePolicy: "COST",
        items: [{ productId: productoSinCostoId, quantity: 1 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no tiene costo cargado/u);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // PAGOS
  // ══════════════════════════════════════════════════════════════════════

  describe("🔒 sólo el efectivo toca la caja", () => {
    let cuentaId = 0;

    beforeAll(async () => {
      const cuenta = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
      });
      cuentaId = cuenta!.id;
    });

    const pagar = (body: Record<string, unknown>) =>
      request(app)
        .post(`/api/staff-accounts/${cuentaId}/payments`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send(body);

    it("un pago en efectivo entra al arqueo", async () => {
      const antes = await prisma.cashMovement.count({ where: { cashRegisterId } });

      const res = await pagar({ method: "CASH", amount: 5000, cashRegisterId });
      expect(res.status).toBe(201);
      expect(res.body.data.affectedCashRegister).toBe(true);

      const despues = await prisma.cashMovement.count({ where: { cashRegisterId } });
      expect(despues).toBe(antes + 1);
    });

    it("un descuento de haberes baja la deuda y NO toca la caja", async () => {
      const antes = await prisma.cashMovement.count({ where: { cashRegisterId } });

      const res = await pagar({ method: "PAYROLL_DEDUCTION", amount: 3000 });
      expect(res.status).toBe(201);
      expect(res.body.data.affectedCashRegister).toBe(false);

      // Si esto entrara al arqueo, la caja nunca cerraría: se descontó de un
      // sueldo, no entró un peso al cajón.
      expect(await prisma.cashMovement.count({ where: { cashRegisterId } })).toBe(antes);
    });

    it("una transferencia tampoco toca la caja", async () => {
      const antes = await prisma.cashMovement.count({ where: { cashRegisterId } });
      const res = await pagar({ method: "TRANSFER", amount: 1000, reference: "OP-123" });
      expect(res.status).toBe(201);
      expect(await prisma.cashMovement.count({ where: { cashRegisterId } })).toBe(antes);
    });

    it("un pago en efectivo sin caja se rechaza", async () => {
      const res = await pagar({ method: "CASH", amount: 1000 });
      expect(res.status).toBe(400);
    });

    it("condonar exige motivo Y capacidad de ajuste", async () => {
      const sinMotivo = await pagar({ method: "WRITE_OFF", amount: 500 });
      expect(sinMotivo.status).toBe(400);

      const empleadoCondonando = await request(app)
        .post(`/api/staff-accounts/${cuentaId}/payments`)
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ method: "WRITE_OFF", amount: 500, reason: "me lo perdono solo" });
      // Condonar es regalar plata de la empresa.
      expect(empleadoCondonando.status).toBe(403);
    });

    it("el saldo refleja consumos menos pagos", async () => {
      const asientos = await prisma.staffLedgerEntry.findMany({
        where: { staffAccountId: cuentaId },
        select: { debit: true, credit: true },
      });
      const saldo = asientos.reduce(
        (s, a) => s + Number(a.debit) - Number(a.credit),
        0,
      );
      // 20.000 de consumo − 5.000 efectivo − 3.000 haberes − 1.000 transferencia
      expect(saldo).toBe(11000);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // VISIBILIDAD
  // ══════════════════════════════════════════════════════════════════════

  describe("🔒 cada uno ve lo suyo", () => {
    it("un empleado sólo se ve a sí mismo en el listado", async () => {
      const res = await request(app)
        .get("/api/staff-accounts")
        .set("Authorization", `Bearer ${empleadoToken}`);

      expect(res.status).toBe(200);
      expect(res.body.summary.scope).toBe("PROPIA");
      for (const cuenta of res.body.data) {
        expect(cuenta.user.id).toBe(empleadoId);
      }
    });

    it("el admin ve todas", async () => {
      const res = await request(app)
        .get("/api/staff-accounts")
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.body.summary.scope).toBe("TODAS");
      expect(res.body.data.length).toBeGreaterThan(1);
    });

    it("un empleado NO puede leer el extracto de un compañero", async () => {
      const ajena = await prisma.staffAccount.findUnique({
        where: { userId: otroEmpleadoId },
      });
      const res = await request(app)
        .get(`/api/staff-accounts/${ajena!.id}/ledger`)
        .set("Authorization", `Bearer ${empleadoToken}`);

      expect(res.status).toBe(403);
    });

    it("pero SÍ el suyo", async () => {
      const propia = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
      });
      const res = await request(app)
        .get(`/api/staff-accounts/${propia!.id}/ledger`)
        .set("Authorization", `Bearer ${empleadoToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.entries.length).toBeGreaterThan(0);
    });

    it("/me responde sin tener que saber el id", async () => {
      const res = await request(app)
        .get("/api/staff-accounts/me")
        .set("Authorization", `Bearer ${empleadoToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.exists).toBe(true);
      expect(res.body.data.balance).toBe(11000);
    });

    it("quien nunca consumió no tiene cuenta, y eso no es un error", async () => {
      const nuevo = await prisma.user.create({
        data: {
          name: `Recien ${runId}`,
          email: `staff_new_${runId}@x.com`,
          password: "x",
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      });
      const token = generateTestToken({
        userId: nuevo.id,
        role: "EMPLOYEE",
        branchIds: [branchId],
      });

      const res = await request(app)
        .get("/api/staff-accounts/me")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.exists).toBe(false);
      expect(res.body.data.balance).toBe(0);

      await prisma.user.delete({ where: { id: nuevo.id } });
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // INMUTABILIDAD
  // ══════════════════════════════════════════════════════════════════════

  describe("🔒 el libro se corrige agregando, no editando", () => {
    it("un ajuste crea un asiento nuevo y deja el anterior intacto", async () => {
      const cuenta = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
      });

      const antes = await prisma.staffLedgerEntry.findMany({
        where: { staffAccountId: cuenta!.id },
        orderBy: { id: "asc" },
      });

      const res = await request(app)
        .post(`/api/staff-accounts/${cuenta!.id}/adjustments`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ direction: "CREDIT", amount: 1000, reason: "Error de carga del martes" });

      expect(res.status).toBe(201);
      expect(res.body.data.newBalance).toBe(10000);

      const despues = await prisma.staffLedgerEntry.findMany({
        where: { staffAccountId: cuenta!.id },
        orderBy: { id: "asc" },
      });

      expect(despues).toHaveLength(antes.length + 1);
      // Ni uno solo de los asientos anteriores cambió.
      for (const [i, original] of antes.entries()) {
        expect(Number(despues[i]!.debit)).toBe(Number(original.debit));
        expect(Number(despues[i]!.credit)).toBe(Number(original.credit));
      }
    });

    it("un ajuste sin motivo se rechaza", async () => {
      const cuenta = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
      });
      const res = await request(app)
        .post(`/api/staff-accounts/${cuenta!.id}/adjustments`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ direction: "DEBIT", amount: 100, reason: "" });

      // Un ajuste sin motivo es indistinguible de un error.
      expect(res.status).toBe(400);
    });

    it("un empleado no puede ajustar su propia cuenta", async () => {
      const cuenta = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
      });
      const res = await request(app)
        .post(`/api/staff-accounts/${cuenta!.id}/adjustments`)
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ direction: "CREDIT", amount: 99999, reason: "me perdono la deuda" });

      expect(res.status).toBe(403);
    });
  });
  describe("el extracto se puede discutir", () => {
    it("dice QUÉ se llevó, no sólo cuánto", async () => {
      // Un cargo que dice "Se llevó mercadería · $12.000" no se puede ni
      // reclamar ni reconocer: para eso hay que saber qué mercadería. El
      // vínculo ya existía en la base y nadie lo resolvía.
      await consumo(adminToken, {
        kind: "EMPLOYEE_PERSONAL",
        staffUserId: empleadoId,
        branchId,
        cashRegisterId,
        items: [{ productId, quantity: 2 }],
      });

      const cuenta = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
      });
      const res = await request(app)
        .get(`/api/staff-accounts/${cuenta!.id}/ledger`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const cargo = res.body.data.entries.find(
        (e: { type: string }) => e.type === "CONSUMPTION",
      );
      expect(cargo).toBeDefined();
      expect(cargo.detalle).not.toBeNull();
      expect(cargo.detalle.clase).toBe("CONSUMO");
      expect(cargo.detalle.items.length).toBeGreaterThan(0);
      // El nombre del producto, no su id.
      expect(typeof cargo.detalle.items[0].nombre).toBe("string");
      expect(cargo.detalle.items[0].nombre.length).toBeGreaterThan(0);
      expect(cargo.detalle.items[0].cantidad).toBe(2);
    });

    it("dice QUIÉN registró cada movimiento", async () => {
      const cuenta = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
      });
      const res = await request(app)
        .get(`/api/staff-accounts/${cuenta!.id}/ledger`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.entries.length).toBeGreaterThan(0);
      for (const asiento of res.body.data.entries) {
        // Sin autor, el libro es una lista de números que alguien puso ahí.
        expect(asiento.registradoPor).toBeTruthy();
      }
    });

    it("filtrar por CARGOS no cambia el saldo que la persona debe", async () => {
      const cuenta = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
      });

      const todo = await request(app)
        .get(`/api/staff-accounts/${cuenta!.id}/ledger`)
        .set("Authorization", `Bearer ${adminToken}`);
      const soloCargos = await request(app)
        .get(`/api/staff-accounts/${cuenta!.id}/ledger`)
        .query({ tipo: "CARGOS" })
        .set("Authorization", `Bearer ${adminToken}`);

      expect(soloCargos.status).toBe(200);
      // El filtro es una lente sobre la lista, no sobre la deuda: si el saldo
      // cambiara al filtrar, el número dejaría de ser lo que se debe.
      expect(soloCargos.body.data.account.balance).toBe(
        todo.body.data.account.balance,
      );
      expect(soloCargos.body.data.entries.length).toBeLessThanOrEqual(
        todo.body.data.entries.length,
      );
      for (const a of soloCargos.body.data.entries) {
        expect(a.debit).toBeGreaterThan(0);
      }
    });
  });
});
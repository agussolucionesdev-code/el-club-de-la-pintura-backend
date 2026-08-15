/**
 * Incentivos, de punta a punta contra la base real.
 *
 * El motor puro ya está cubierto en `incentive-engine.test.ts`. Acá se prueba
 * lo que sólo se rompe con Postgres del otro lado: qué ventas entran, qué
 * ventas quedan afuera, quién puede ver qué, y —lo más delicado— que la
 * comisión aprobada llegue al recibo de sueldo UNA vez y no dos.
 *
 * El escenario que más me importa es el arrastre: un fiado de un período viejo
 * que se cobra ahora. Sin él, la persona hizo la venta y nunca cobraría su
 * comisión, porque en su período no había entrado la plata y para cuando entró
 * la venta ya no cae en el período. Se perdería por un detalle de
 * implementación, y nadie lo notaría.
 */

import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import { testTerminalFor } from "./helpers/terminal";

describe("Incentivos", () => {
  const runId = Date.now();
  let branchId = 0;
  let adminId = 0;
  let vendedorId = 0;
  let otroVendedorId = 0;
  let adminToken = "";
  let vendedorToken = "";
  let productId = 0;
  let cashRegisterId = 0;
  let clienteId = 0;
  let planId = 0;
  let empleadoLegajoId = 0;
  let legajoOtroId = 0;

  /** Clave del período mensual actual, en hora argentina. */
  const claveDeHoy = (): string => {
    const ar = new Date(Date.now() - 180 * 60_000);
    return `${ar.getUTCFullYear()}-${String(ar.getUTCMonth() + 1).padStart(2, "0")}`;
  };

  /**
   * Crea una venta ya consumada, salteando el POS.
   *
   * `balance` es lo que falta cobrar: 0 = cobrada al contado, igual al total =
   * fiado puro. Es la palanca que mueve la elegibilidad bajo la política MIXED.
   */
  const crearVenta = async (opts: {
    total: number;
    balance: number;
    sellerId: number;
    kind?: string;
    status?: string;
    unitCost?: number | null;
    createdAt?: Date;
  }) => {
    const venta = await prisma.sale.create({
      data: {
        totalAmount: opts.total,
        paymentMethod: opts.balance > 0 ? "CREDIT_ACCOUNT" : "CASH",
        status: opts.status ?? (opts.balance > 0 ? "PARTIAL" : "PAID"),
        balance: opts.balance,
        customerId: clienteId,
        branchId,
        userId: opts.sellerId,
        sellerId: opts.sellerId,
        cashierId: opts.sellerId,
        cashRegisterId,
        kind: opts.kind ?? "SALE",
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      },
    });
    await prisma.saleItem.create({
      data: {
        saleId: venta.id,
        productId,
        quantity: 1,
        unitPrice: opts.total,
        subtotal: opts.total,
        unitCost: opts.unitCost === undefined ? opts.total / 2 : opts.unitCost,
      },
    });
    return venta;
  };

  const limpiarIncentivos = async () => {
    await prisma.incentiveSettlement.deleteMany({ where: { period: { planId } } });
    await prisma.incentiveLedgerEntry.deleteMany({ where: { period: { planId } } });
    await prisma.salesTarget.deleteMany({ where: { period: { planId } } });
    await prisma.incentivePeriod.deleteMany({ where: { planId } });
  };

  const limpiarVentas = async () => {
    const ventas = await prisma.sale.findMany({
      where: { branchId },
      select: { id: true },
    });
    const ids = ventas.map((v) => v.id);
    if (ids.length === 0) return;
    await prisma.incentiveLedgerEntry.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.saleItem.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.payment.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.sale.deleteMany({ where: { id: { in: ids } } });
  };

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `Inc-${runId}`, location: "Test", isActive: true },
    });
    branchId = branch.id;

    const hash = await bcrypt.hash("Password123!", 10);
    const admin = await prisma.user.create({
      data: {
        name: `IncAdmin-${runId}`,
        email: `inc-admin-${runId}@test.local`,
        password: hash,
        role: "ADMIN",
        branches: { connect: [{ id: branchId }] },
      },
    });
    adminId = admin.id;

    const vendedor = await prisma.user.create({
      data: {
        name: `IncVendedor-${runId}`,
        email: `inc-vend-${runId}@test.local`,
        password: hash,
        role: "EMPLOYEE",
        branches: { connect: [{ id: branchId }] },
      },
    });
    vendedorId = vendedor.id;

    const otro = await prisma.user.create({
      data: {
        name: `IncOtro-${runId}`,
        email: `inc-otro-${runId}@test.local`,
        password: hash,
        role: "EMPLOYEE",
        branches: { connect: [{ id: branchId }] },
      },
    });
    otroVendedorId = otro.id;

    // El vendedor necesita legajo: sin legajo no hay recibo donde imputar.
    const legajo = await prisma.employee.create({
      data: {
        userId: vendedorId,
        position: "Vendedor",
        salaryType: "COMMISSION",
        baseSalary: 0,
        branchId,
      },
    });
    empleadoLegajoId = legajo.id;

    const legajoOtro = await prisma.employee.create({
      data: {
        userId: otroVendedorId,
        position: "Vendedor",
        salaryType: "COMMISSION",
        baseSalary: 0,
        branchId,
      },
    });
    legajoOtroId = legajoOtro.id;

    adminToken = generateTestToken({ userId: adminId, role: "ADMIN", branchIds: [branchId] });
    vendedorToken = generateTestToken({
      userId: vendedorId,
      role: "EMPLOYEE",
      branchIds: [branchId],
    });

    const producto = await prisma.product.create({
      data: {
        name: `IncProd-${runId}`,
        sku: `INC-${runId}`,
        brand: "Robot",
        category: "Pruebas",
        retailPrice: 1000,
        costPrice: 500,
      },
    });
    productId = producto.id;

    clienteId = (
      await prisma.customer.create({
        data: { name: `IncCliente-${runId}`, type: "REGULAR" },
      })
    ).id;

    const terminalId = await testTerminalFor(branchId);
    cashRegisterId = (
      await prisma.cashRegister.create({
        data: { branchId, terminalId, userId: adminId, initialBalance: 0, status: "OPEN" },
      })
    ).id;
  });

  afterAll(async () => {
    await limpiarIncentivos();
    await prisma.incentiveRule.deleteMany({ where: { planId } });
    await prisma.incentivePlan.deleteMany({ where: { id: planId } });
    await limpiarVentas();
    await prisma.payrollRecord.deleteMany({
      where: { employeeId: { in: [empleadoLegajoId, legajoOtroId] } },
    });
    await prisma.employee.deleteMany({
      where: { id: { in: [empleadoLegajoId, legajoOtroId] } },
    });
    await prisma.cashRegister.deleteMany({ where: { branchId } });
    await prisma.terminal.deleteMany({ where: { branchId } });
    await prisma.customer.deleteMany({ where: { id: clienteId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({
      where: { id: { in: [adminId, vendedorId, otroVendedorId] } },
    });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  // ─────────────────────────────────────────────────────────────────────────

  describe("el login sigue funcionando", () => {
    it("montar este router en /api no rompe la autenticación de la app", async () => {
      // Ya pasó dos veces en este proyecto: un `router.use(authenticateToken)`
      // en un router montado en `/api` corre para TODO request que entre por
      // ahí y tira abajo el login. Este test es el que lo caza.
      const res = await request(app)
        .post("/api/users/login")
        .send({ email: `inc-admin-${runId}@test.local`, password: "Password123!" });
      expect(res.status).toBe(200);
    });
  });

  describe("creación del plan", () => {
    it("rechaza un plan sin reglas", async () => {
      const res = await request(app)
        .post("/api/incentive-plans")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: "Sin reglas",
          effectiveFrom: new Date().toISOString(),
          rules: [],
        });
      expect(res.status).toBe(400);
    });

    it("rechaza escalones con un hueco entre medio", async () => {
      const res = await request(app)
        .post("/api/incentive-plans")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: "Con hueco",
          effectiveFrom: new Date().toISOString(),
          rules: [
            { kind: "TIERED_PERCENT", percent: 3, fromAmount: 0, toAmount: 100000 },
            // Arranca en 200.000: la base entre 100k y 200k no comisionaría nadie.
            { kind: "TIERED_PERCENT", percent: 4, fromAmount: 200000, toAmount: null },
          ],
        });
      expect(res.status).toBe(400);
    });

    it("rechaza mezclar familias de reglas", async () => {
      const res = await request(app)
        .post("/api/incentive-plans")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: "Mezcla",
          effectiveFrom: new Date().toISOString(),
          rules: [
            { kind: "PERCENT_OF_SALES", percent: 3 },
            { kind: "FIXED_ON_TARGET", fixedAmount: 1000, targetAmount: 5000 },
          ],
        });
      expect(res.status).toBe(400);
    });

    it("un empleado no puede crear un plan", async () => {
      const res = await request(app)
        .post("/api/incentive-plans")
        .set("Authorization", `Bearer ${vendedorToken}`)
        .send({
          name: "Me subo el sueldo",
          effectiveFrom: new Date().toISOString(),
          rules: [{ kind: "PERCENT_OF_SALES", percent: 99 }],
        });
      expect(res.status).toBe(403);
    });

    it("el admin crea el plan mensual al 5% con política MIXED", async () => {
      const res = await request(app)
        .post("/api/incentive-plans")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          name: `Plan ${runId}`,
          cadence: "MONTHLY",
          eligibilityPolicy: "MIXED",
          effectiveFrom: new Date(Date.now() - 90 * 86_400_000).toISOString(),
          rules: [{ kind: "PERCENT_OF_SALES", percent: 5 }],
        });
      expect(res.status).toBe(201);
      planId = res.body.data.id;
      expect(res.body.data.eligibilityPolicy).toBe("MIXED");
    });
  });

  describe("qué entra y qué queda afuera", () => {
    beforeEach(async () => {
      await limpiarIncentivos();
      await limpiarVentas();
    });

    const calcular = () =>
      request(app)
        .post("/api/incentive-periods/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ planId, key: claveDeHoy() });

    it("MIXED: lo cobrado es elegible y el fiado queda provisional", async () => {
      await crearVenta({ total: 100000, balance: 0, sellerId: vendedorId }); // contado
      await crearVenta({ total: 100000, balance: 100000, sellerId: vendedorId }); // fiado

      const res = await calcular();
      expect(res.status).toBe(200);

      const asientos = await prisma.incentiveLedgerEntry.findMany({
        where: { userId: vendedorId },
      });
      const elegible = asientos.filter((a) => a.status === "ELIGIBLE");
      const provisional = asientos.filter((a) => a.status === "PROVISIONAL");

      // 5% de 100.000 cobrados = 5.000. Y 5.000 más a la espera del fiado.
      expect(Number(elegible[0]!.commissionAmount)).toBe(5000);
      expect(Number(provisional[0]!.commissionAmount)).toBe(5000);
    });

    it("el consumo interno NO genera comisión", async () => {
      await crearVenta({
        total: 50000,
        balance: 50000,
        sellerId: vendedorId,
        kind: "INTERNAL_CONSUMPTION",
      });

      await calcular();

      const asientos = await prisma.incentiveLedgerEntry.count({
        where: { userId: vendedorId },
      });
      // Pagarle comisión a alguien por llevarse mercadería sería pagarle por gastar.
      expect(asientos).toBe(0);
    });

    it("una venta anulada NO genera comisión", async () => {
      await crearVenta({
        total: 80000,
        balance: 0,
        sellerId: vendedorId,
        status: "CANCELLED",
      });

      await calcular();

      expect(
        await prisma.incentiveLedgerEntry.count({ where: { userId: vendedorId } }),
      ).toBe(0);
    });

    it("el costo desconocido no se cuenta como cero: queda fuera y se informa", async () => {
      // Sólo importa cuando el plan tiene regla de margen.
      const conMargen = await prisma.incentivePlan.create({
        data: {
          name: `Margen ${runId}`,
          cadence: "MONTHLY",
          eligibilityPolicy: "ON_SALE",
          minMarginPct: 20,
          effectiveFrom: new Date(Date.now() - 86_400_000),
          createdById: adminId,
          rules: { create: [{ kind: "PERCENT_OF_SALES", percent: 5, effectiveFrom: new Date() }] },
        },
      });

      await crearVenta({ total: 40000, balance: 0, sellerId: vendedorId, unitCost: null });

      const res = await request(app)
        .post("/api/incentive-periods/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ planId: conMargen.id, key: claveDeHoy() });

      expect(res.status).toBe(200);
      // Se informa el monto, no se esconde ni se asume margen cero.
      //
      // Se compara con `>=` y no con `===` a propósito: el cálculo de
      // incentivos mira las ventas de TODA la empresa en el período, que es lo
      // correcto para el negocio, así que cualquier venta sin costo que deje
      // otra suite de tests en el mismo mes también suma acá. Exigir igualdad
      // haría que este test falle por algo que pasó en otro archivo.
      expect(Number(res.body.data.unevaluableBase)).toBeGreaterThanOrEqual(40000);

      const asiento = await prisma.incentiveLedgerEntry.findFirst({
        where: { period: { planId: conMargen.id } },
      });
      expect(asiento?.marginKnown).toBe(false);
      expect(asiento?.status).toBe("PROVISIONAL");
      expect(Number(asiento?.commissionAmount)).toBe(0);

      await prisma.incentiveLedgerEntry.deleteMany({ where: { period: { planId: conMargen.id } } });
      await prisma.incentivePeriod.deleteMany({ where: { planId: conMargen.id } });
      await prisma.incentiveRule.deleteMany({ where: { planId: conMargen.id } });
      await prisma.incentivePlan.delete({ where: { id: conMargen.id } });
    });
  });

  describe("arrastre entre períodos", () => {
    it("un fiado viejo cobrado ahora paga su comisión en el período de HOY", async () => {
      await limpiarIncentivos();
      await limpiarVentas();

      // Una venta de hace dos meses, fiada, todavía impaga.
      const haceDosMeses = new Date(Date.now() - 62 * 86_400_000);
      const claveVieja = `${new Date(haceDosMeses.getTime() - 180 * 60_000).getUTCFullYear()}-${String(
        new Date(haceDosMeses.getTime() - 180 * 60_000).getUTCMonth() + 1,
      ).padStart(2, "0")}`;

      const venta = await crearVenta({
        total: 200000,
        balance: 200000,
        sellerId: vendedorId,
        createdAt: haceDosMeses,
      });

      // Se liquida aquel período: la comisión queda provisional, no se paga.
      const viejo = await request(app)
        .post("/api/incentive-periods/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ planId, key: claveVieja });
      expect(viejo.status).toBe(200);

      const enElViejo = await prisma.incentiveLedgerEntry.findMany({
        where: { saleId: venta.id },
      });
      expect(enElViejo).toHaveLength(1);
      expect(enElViejo[0]!.status).toBe("PROVISIONAL");

      // Ahora el cliente paga.
      await prisma.sale.update({
        where: { id: venta.id },
        data: { balance: 0, status: "PAID" },
      });

      // Y se liquida el período de hoy.
      const hoy = await request(app)
        .post("/api/incentive-periods/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ planId, key: claveDeHoy() });
      expect(hoy.status).toBe(200);
      expect(hoy.body.data.carriedOver).toBeGreaterThan(0);

      const elegibles = await prisma.incentiveLedgerEntry.findMany({
        where: { saleId: venta.id, status: "ELIGIBLE" },
      });
      expect(elegibles).toHaveLength(1);
      expect(Number(elegibles[0]!.commissionAmount)).toBe(10000); // 5% de 200.000
      expect(elegibles[0]!.reason).toMatch(/período anterior/u);
    });

    it("recalcular no paga la misma venta dos veces", async () => {
      await request(app)
        .post("/api/incentive-periods/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ planId, key: claveDeHoy() });

      const total = await prisma.incentiveLedgerEntry.aggregate({
        where: { status: "ELIGIBLE", userId: vendedorId },
        _sum: { commissionAmount: true },
      });
      expect(Number(total._sum.commissionAmount ?? 0)).toBe(10000);
    });
  });

  describe("visibilidad", () => {
    it("un vendedor ve lo suyo y NADA de sus compañeros", async () => {
      await limpiarIncentivos();
      await limpiarVentas();
      await crearVenta({ total: 100000, balance: 0, sellerId: vendedorId });
      await crearVenta({ total: 900000, balance: 0, sellerId: otroVendedorId });
      await request(app)
        .post("/api/incentive-periods/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ planId, key: claveDeHoy() });

      const res = await request(app)
        .get(`/api/incentive-periods/${claveDeHoy()}/performance?planId=${planId}`)
        .set("Authorization", `Bearer ${vendedorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.scope).toBe("OWN");
      expect(res.body.data.rows).toHaveLength(1);
      expect(res.body.data.rows[0].user.id).toBe(vendedorId);
    });

    it("el admin ve a todos", async () => {
      const res = await request(app)
        .get(`/api/incentive-periods/${claveDeHoy()}/performance?planId=${planId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.body.data.scope).toBe("ALL");
      expect(res.body.data.rows.length).toBeGreaterThanOrEqual(2);
    });

    it("el detalle propio muestra en qué venta se ganó cada peso", async () => {
      const res = await request(app)
        .get(`/api/incentives/me?key=${claveDeHoy()}&planId=${planId}`)
        .set("Authorization", `Bearer ${vendedorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.totals.payable).toBe(5000);
      expect(res.body.data.entries[0]).toHaveProperty("saleId");
    });
  });

  describe("liquidación", () => {
    it("un vendedor no puede aprobar su propia liquidación", async () => {
      const periodo = await prisma.incentivePeriod.findFirst({ where: { planId } });
      const res = await request(app)
        .post(`/api/incentive-periods/${periodo!.id}/transition`)
        .set("Authorization", `Bearer ${vendedorToken}`)
        .send({ to: "REVIEWED" });
      expect(res.status).toBe(403);
    });

    it("no se saltea la aprobación", async () => {
      const periodo = await prisma.incentivePeriod.findFirst({ where: { planId } });
      const res = await request(app)
        .post(`/api/incentive-periods/${periodo!.id}/transition`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ to: "PAID" });
      expect(res.status).toBe(409);
    });

    it("recorre el ciclo y el bono llega al recibo de sueldo", async () => {
      const periodo = await prisma.incentivePeriod.findFirst({ where: { planId } });
      const mover = (to: string) =>
        request(app)
          .post(`/api/incentive-periods/${periodo!.id}/transition`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ to });

      expect((await mover("REVIEWED")).status).toBe(200);
      expect((await mover("APPROVED")).status).toBe(200);

      const liquidacion = await prisma.incentiveSettlement.findFirst({
        where: { periodId: periodo!.id, userId: vendedorId },
      });
      expect(Number(liquidacion!.totalAmount)).toBe(5000);

      expect((await mover("LOCKED")).status).toBe(200);
      expect((await mover("PAID")).status).toBe(200);

      const recibo = await prisma.payrollRecord.findFirst({
        where: { employeeId: empleadoLegajoId },
      });
      expect(Number(recibo!.bonuses)).toBe(5000);
    });

    it("un período cerrado ya NO se recalcula", async () => {
      const res = await request(app)
        .post("/api/incentive-periods/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ planId, key: claveDeHoy() });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/no se recalcula/u);
    });

    it("la liquidación queda atada a UN recibo: no se puede sumar dos veces", async () => {
      const periodo = await prisma.incentivePeriod.findFirst({ where: { planId } });
      const liquidacion = await prisma.incentiveSettlement.findFirst({
        where: { periodId: periodo!.id, userId: vendedorId },
      });
      const recibo = await prisma.payrollRecord.findFirst({
        where: { employeeId: empleadoLegajoId },
      });

      expect(liquidacion!.payrollRecordId).toBe(recibo!.id);

      // La base rechaza un segundo settlement apuntando al mismo recibo. Sin
      // esto, re-aprobar sumaría el bono dos veces y nadie lo notaría hasta que
      // la persona cobrara de más.
      await expect(
        prisma.incentiveSettlement.create({
          data: {
            periodId: periodo!.id,
            userId: otroVendedorId,
            totalAmount: 1,
            approvedById: adminId,
            payrollRecordId: recibo!.id,
          },
        }),
      ).rejects.toThrow();
    });

    it("no le agrega un bono a un sueldo YA PAGADO", async () => {
      await limpiarIncentivos();
      await limpiarVentas();
      await crearVenta({ total: 60000, balance: 0, sellerId: vendedorId });

      await prisma.payrollRecord.updateMany({
        where: { employeeId: empleadoLegajoId },
        data: { status: "PAID" },
      });

      const calc = await request(app)
        .post("/api/incentive-periods/calculate")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ planId, key: claveDeHoy() });
      expect(calc.status).toBe(200);

      const periodo = await prisma.incentivePeriod.findFirst({ where: { planId } });
      const mover = (to: string) =>
        request(app)
          .post(`/api/incentive-periods/${periodo!.id}/transition`)
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ to });

      await mover("REVIEWED");
      await mover("APPROVED");
      await mover("LOCKED");
      const pago = await mover("PAID");

      expect(pago.status).toBe(409);
      expect(pago.body.error).toMatch(/ya está PAGADO/u);

      // Y el recibo quedó intacto.
      const recibo = await prisma.payrollRecord.findFirst({
        where: { employeeId: empleadoLegajoId },
      });
      expect(Number(recibo!.bonuses)).toBe(5000);
    });
  });
});

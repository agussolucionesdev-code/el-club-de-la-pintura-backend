/**
 * Traslado de cuentas internas legado.
 *
 * Este archivo defiende las dos correcciones que el dueño del proyecto me hizo
 * después de rechazar dos versiones del modelo:
 *
 *   1. **No se falsifica el histórico.** Las ventas trasladadas conservan su
 *      `status`, su `balance`, sus pagos y sus devoluciones. Nada declara
 *      cobrado lo que nunca se cobró.
 *
 *   2. **Un traslado revertido se puede rehacer.** Los ciclos lo permiten; el
 *      `saleId @unique` de la versión anterior lo habría hecho imposible.
 *
 * Y la garantía que hace que esto sea seguro de correr contra datos reales: la
 * reconciliación. Lo que sale de Cuentas Corrientes tiene que entrar al libro,
 * peso por peso, o no se committea nada.
 */

import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import { testTerminalFor } from "./helpers/terminal";

describe("Traslado de cuentas legado", () => {
  const runId = Date.now();
  let branchId = 0;
  let adminId = 0;
  let empleadoId = 0;
  let adminToken = "";
  let empleadoToken = "";
  let clienteInternoId = 0;
  let productId = 0;
  let cashRegisterId = 0;
  const ventasLegado: number[] = [];

  /** Crea una venta a cuenta corriente del cliente interno, como el sistema viejo. */
  const ventaLegado = async (total: number, saldo: number) => {
    const venta = await prisma.sale.create({
      data: {
        totalAmount: total,
        paymentMethod: "CREDIT_ACCOUNT",
        status: saldo === total ? "PENDING" : "PARTIAL",
        balance: saldo,
        customerId: clienteInternoId,
        branchId,
        userId: adminId,
        sellerId: adminId,
        cashierId: adminId,
        cashRegisterId,
      },
    });
    ventasLegado.push(venta.id);
    return venta;
  };

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `Legacy ${runId}`, location: "A" },
    });
    branchId = branch.id;

    const password = await bcrypt.hash("supersecretpassword", 10);
    const [admin, emp] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Admin Legacy ${runId}`,
          email: `leg_admin_${runId}@x.com`,
          password,
          role: "ADMIN",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Juan Pintor ${runId}`,
          email: `leg_emp_${runId}@x.com`,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
    ]);
    adminId = admin.id;
    empleadoId = emp.id;

    adminToken = generateTestToken({ userId: adminId, role: "ADMIN", branchIds: [branchId] });
    empleadoToken = generateTestToken({
      userId: empleadoId,
      role: "EMPLOYEE",
      branchIds: [branchId],
    });

    // La cuenta vieja: un `Customer` INTERNAL creado escribiendo un nombre.
    const interno = await prisma.customer.create({
      data: { name: `Juan P. ${runId}`, type: "INTERNAL" },
    });
    clienteInternoId = interno.id;

    const prod = await prisma.product.create({
      data: {
        sku: `LEG-${runId}`,
        name: `Producto Legacy ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        retailPrice: 10000,
        costPrice: 4000,
      },
    });
    productId = prod.id;

    const terminalId = await testTerminalFor(branchId);
    const caja = await prisma.cashRegister.create({
      data: { branchId, terminalId, userId: adminId, initialBalance: 0, status: "OPEN" },
    });
    cashRegisterId = caja.id;

    // Tres deudas viejas: 30.000 en total.
    await ventaLegado(20000, 15000);
    await ventaLegado(10000, 10000);
    await ventaLegado(8000, 5000);
  });

  afterAll(async () => {
    await prisma.legacySaleTransfer.deleteMany({
      where: { saleId: { in: ventasLegado } },
    });
    await prisma.staffLedgerEntry.deleteMany({
      where: { staffAccount: { userId: { in: [adminId, empleadoId] } } },
    });
    await prisma.staffAccountLegacyLink.deleteMany({
      where: { legacyCustomerId: clienteInternoId },
    });
    await prisma.staffAccount.deleteMany({
      where: { userId: { in: [adminId, empleadoId] } },
    });
    await prisma.payment.deleteMany({ where: { branchId } });
    await prisma.auditLog.deleteMany({ where: { branchId } });
    await prisma.sale.deleteMany({ where: { branchId } });
    await prisma.cashRegister.deleteMany({ where: { branchId } });
    await prisma.posOperatorSession.deleteMany({
      where: { userId: { in: [adminId, empleadoId] } },
    });
    await prisma.terminal.deleteMany({ where: { branchId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.customer.deleteMany({ where: { id: clienteInternoId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, empleadoId] } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  let linkId = 0;

  describe("proponer el vínculo", () => {
    it("un empleado no puede proponer traslados", async () => {
      const res = await request(app)
        .post("/api/legacy-links")
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ legacyCustomerId: clienteInternoId, userId: empleadoId, reason: "soy yo" });
      expect(res.status).toBe(403);
    });

    it("el listado muestra la deuda real, sin proponer vínculos por nombre", async () => {
      const res = await request(app)
        .get("/api/legacy-links")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const candidato = res.body.data.find(
        (c: { legacyCustomerId: number }) => c.legacyCustomerId === clienteInternoId,
      );
      expect(candidato.pendingBalance).toBe(30000);
      // Que "Juan P." y "Juan Pintor" sean la misma persona lo sabe alguien que
      // trabaja ahí, no un algoritmo de similitud.
      expect(candidato.link).toBeNull();
    });

    it("proponer NO traslada nada todavía", async () => {
      const res = await request(app)
        .post("/api/legacy-links")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          legacyCustomerId: clienteInternoId,
          userId: empleadoId,
          reason: "Cuenta vieja de Juan, confirmado con él",
        });

      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe("PROPOSED");
      linkId = res.body.data.id;

      // Las ventas siguen intactas.
      const ventas = await prisma.sale.findMany({ where: { id: { in: ventasLegado } } });
      for (const v of ventas) {
        expect(Number(v.transferredToStaffLedger)).toBe(0);
      }
    });
  });

  describe("🔒 confirmar el traslado", () => {
    it("mueve la deuda y RECONCILIA las dos puntas", async () => {
      const res = await request(app)
        .post(`/api/legacy-links/${linkId}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Traslado de la cuenta interna de Juan al libro del personal" });

      expect(res.status).toBe(200);
      expect(res.body.data.transferredTotal).toBe(30000);
      expect(res.body.data.salesAffected).toBe(3);
      // Lo que sale de Cuentas Corrientes entra al libro, peso por peso.
      expect(res.body.data.reconciled).toBe(true);
    });

    it("🔒 NO falsifica el histórico: estado y saldo intactos", async () => {
      const ventas = await prisma.sale.findMany({
        where: { id: { in: ventasLegado } },
        orderBy: { id: "asc" },
      });

      // Ésta es la corrección entera. Mi primera propuesta ponía status='PAID'
      // y balance=0, declarando cobrado lo que nunca se cobró.
      expect(ventas[0]!.status).toBe("PARTIAL");
      expect(Number(ventas[0]!.balance)).toBe(15000);
      expect(ventas[1]!.status).toBe("PENDING");
      expect(Number(ventas[1]!.balance)).toBe(10000);

      // Lo trasladado se anota APARTE.
      expect(Number(ventas[0]!.transferredToStaffLedger)).toBe(15000);
      expect(Number(ventas[1]!.transferredToStaffLedger)).toBe(10000);
      expect(Number(ventas[2]!.transferredToStaffLedger)).toBe(5000);
    });

    it("la deuda aparece en el libro del empleado", async () => {
      const cuenta = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
        include: { entries: true },
      });

      const apertura = cuenta!.entries.find((e) => e.type === "OPENING_BALANCE");
      expect(apertura).toBeDefined();
      expect(Number(apertura!.debit)).toBe(30000);
      // El desglose por venta queda adentro, inmutable.
      expect((apertura!.metadata as { sales: unknown[] }).sales).toHaveLength(3);
      // Trasladar deuda de alguien exige una firma.
      expect(apertura!.authorizedById).toBe(adminId);
    });

    it("la cuenta legado sale del selector", async () => {
      const cliente = await prisma.customer.findUnique({
        where: { id: clienteInternoId },
      });
      expect(cliente!.isActive).toBe(false);
    });

    it("un ciclo por venta, todos ACTIVE", async () => {
      const ciclos = await prisma.legacySaleTransfer.findMany({
        where: { saleId: { in: ventasLegado } },
      });
      expect(ciclos).toHaveLength(3);
      for (const c of ciclos) {
        expect(c.cycleNumber).toBe(1);
        expect(c.status).toBe("ACTIVE");
        // El estado ORIGINAL de la venta queda preservado en el ciclo.
        expect(["PENDING", "PARTIAL"]).toContain(c.originalStatus);
      }
    });

    it("no se puede trasladar dos veces", async () => {
      const res = await request(app)
        .post(`/api/legacy-links/${linkId}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "intento duplicado a ver que pasa" });
      expect(res.status).toBe(400);
    });

    it("🔒 cobrar por la vía vieja queda BLOQUEADO", async () => {
      // La venta conserva su balance a propósito, así que sigue *pareciendo*
      // cobrable. Cobrarla acá sería cobrar dos veces la misma deuda.
      const res = await request(app)
        .post("/api/payments")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          saleId: ventasLegado[1],
          amount: 5000,
          paymentMethod: "CASH",
          cashRegisterId,
        });

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error).toMatch(/libro del personal/u);
    });
  });

  describe("🔒 revertir y re-trasladar", () => {
    it("revertir exige capacidad de AJUSTE, no la de trasladar", async () => {
      const res = await request(app)
        .post(`/api/legacy-links/${linkId}/reverse`)
        .set("Authorization", `Bearer ${empleadoToken}`)
        .send({ reason: "quiero deshacerlo yo" });
      expect(res.status).toBe(403);
    });

    it("revierte SÓLO con asientos compensatorios", async () => {
      const antes = await prisma.staffLedgerEntry.findMany({
        where: { staffAccount: { userId: empleadoId } },
        orderBy: { id: "asc" },
      });
      const aperturaAntes = antes.find((e) => e.type === "OPENING_BALANCE")!;

      const res = await request(app)
        .post(`/api/legacy-links/${linkId}/reverse`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "La cuenta era de otro Juan; se revierte" });

      expect(res.status).toBe(200);
      expect(res.body.data.reversedTotal).toBe(30000);

      const despues = await prisma.staffLedgerEntry.findMany({
        where: { staffAccount: { userId: empleadoId } },
        orderBy: { id: "asc" },
      });

      // El asiento de apertura NO se tocó ni se borró.
      const aperturaDespues = despues.find((e) => e.id === aperturaAntes.id)!;
      expect(Number(aperturaDespues.debit)).toBe(Number(aperturaAntes.debit));

      // Y hay un contra-asiento que apunta a él.
      const compensacion = despues.find((e) => e.type === "TRANSFER_REVERSAL")!;
      expect(compensacion.reversalOfId).toBe(aperturaAntes.id);
      expect(Number(compensacion.credit)).toBe(30000);
    });

    it("el saldo del libro vuelve a cero y la deuda a Cuentas Corrientes", async () => {
      const cuenta = await prisma.staffAccount.findUnique({
        where: { userId: empleadoId },
        include: { entries: { select: { debit: true, credit: true } } },
      });
      const saldo = cuenta!.entries.reduce(
        (s, e) => s + Number(e.debit) - Number(e.credit),
        0,
      );
      expect(saldo).toBe(0);

      const ventas = await prisma.sale.findMany({ where: { id: { in: ventasLegado } } });
      for (const v of ventas) {
        // Acumulados: lo trasladado y lo revertido se igualan, el activo es 0.
        expect(Number(v.transferredToStaffLedger)).toBe(Number(v.transferReversed));
      }

      const cliente = await prisma.customer.findUnique({
        where: { id: clienteInternoId },
      });
      expect(cliente!.isActive).toBe(true);
    });

    it("los ciclos quedan FULLY_REVERSED e inmutables", async () => {
      const ciclos = await prisma.legacySaleTransfer.findMany({
        where: { saleId: { in: ventasLegado } },
      });
      for (const c of ciclos) {
        expect(c.status).toBe("FULLY_REVERSED");
        expect(Number(c.reversedAmount)).toBe(Number(c.transferredAmount));
      }
    });

    it("🔒 SE PUEDE VOLVER A TRASLADAR — ciclo 2", async () => {
      // Ésta es la segunda corrección. Con `saleId @unique` la base habría
      // rechazado este traslado y la promesa de "revertir y rehacer" habría
      // sido mentira.
      const res = await request(app)
        .post(`/api/legacy-links/${linkId}/confirm`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ reason: "Se confirmó que sí era de Juan; se vuelve a trasladar" });

      expect(res.status).toBe(200);
      expect(res.body.data.transferredTotal).toBe(30000);

      const ciclos = await prisma.legacySaleTransfer.findMany({
        where: { saleId: ventasLegado[0] },
        orderBy: { cycleNumber: "asc" },
      });

      expect(ciclos).toHaveLength(2);
      // El ciclo 1 queda archivado y consultable.
      expect(ciclos[0]!.status).toBe("FULLY_REVERSED");
      expect(ciclos[1]!.cycleNumber).toBe(2);
      expect(ciclos[1]!.status).toBe("ACTIVE");
    });

    it("los acumulados cierran sobre TODOS los ciclos", async () => {
      const venta = await prisma.sale.findUnique({ where: { id: ventasLegado[0] } });
      // Ciclo 1: 15.000 trasladados y 15.000 revertidos.
      // Ciclo 2: 15.000 trasladados.
      expect(Number(venta!.transferredToStaffLedger)).toBe(30000);
      expect(Number(venta!.transferReversed)).toBe(15000);
      // El activo es la diferencia: 15.000, que es la deuda real.
      expect(
        Number(venta!.transferredToStaffLedger) - Number(venta!.transferReversed),
      ).toBe(15000);
    });

    it("🔒 la base impide dos ciclos VIVOS sobre la misma venta", async () => {
      // El índice único parcial. Sin él, dos traslados activos duplicarían la
      // deuda de una persona.
      await expect(
        prisma.legacySaleTransfer.create({
          data: {
            legacyLinkId: linkId,
            saleId: ventasLegado[0]!,
            cycleNumber: 99,
            originalStatus: "PARTIAL",
            originalBalance: 15000,
            transferredAmount: 15000,
            status: "ACTIVE",
          },
        }),
      ).rejects.toThrow();
    });
  });
});

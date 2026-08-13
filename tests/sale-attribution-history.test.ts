/**
 * Atribución derivada e historial de ventas.
 *
 * ── Qué defiende este archivo ───────────────────────────────────────────────
 *
 * De `sellerId` sale la comisión que se le paga a una persona. De `cashierId`,
 * de quién es el faltante cuando el arqueo no cierra. Si el navegador pudiera
 * escribir esos campos, cualquiera podría atribuirse las ventas de otro.
 *
 * Y del otro lado: el historial no puede filtrar por sucursales que el usuario
 * no tiene permitidas, ni devolver costos a quien no puede verlos. Ocultar el
 * costo en la pantalla no es control de acceso — el dato viaja igual.
 */

import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import { testTerminalFor } from "./helpers/terminal";

const PASSWORD = "supersecretpassword";

describe("Atribución de ventas e historial", () => {
  const runId = Date.now();
  const emailAdmin = `robot_attr_admin_${runId}@elclub.com`;
  const emailEmpleado = `robot_attr_emp_${runId}@elclub.com`;

  let branchId = 0;
  let otraSucursalId = 0;
  let adminId = 0;
  let empleadoId = 0;
  let adminToken = "";
  let empleadoToken = "";
  let productId = 0;
  let terminalId = 0;
  let cashRegisterId = 0;
  let clienteId = 0;
  let clienteInternoId = 0;

  const ventasCreadas: number[] = [];

  const nuevaVenta = (
    token: string,
    extra: Record<string, unknown> = {},
    cantidad = 1,
  ) =>
    request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", `attr-${runId}-${Math.random().toString(36).slice(2, 12)}`)
      .send({
        branchId,
        cashRegisterId,
        paymentMethod: "CASH",
        items: [{ productId, quantity: cantidad }],
        totalAmount: 1000 * cantidad,
        ...extra,
      });

  beforeAll(async () => {
    const [branch, otra] = await Promise.all([
      prisma.branch.create({ data: { name: `Suc Attr ${runId}`, location: "A" } }),
      prisma.branch.create({ data: { name: `Suc Attr B ${runId}`, location: "B" } }),
    ]);
    branchId = branch.id;
    otraSucursalId = otra.id;

    const password = await bcrypt.hash(PASSWORD, 10);
    const [admin, empleado] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Admin Attr ${runId}`,
          email: emailAdmin,
          password,
          role: "ADMIN",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Empleado Attr ${runId}`,
          email: emailEmpleado,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
    ]);
    adminId = admin.id;
    empleadoId = empleado.id;

    adminToken = generateTestToken({ userId: adminId, role: "ADMIN", branchIds: [branchId] });
    empleadoToken = generateTestToken({
      userId: empleadoId,
      role: "EMPLOYEE",
      branchIds: [branchId],
    });

    const producto = await prisma.product.create({
      data: {
        name: `Latex Attr ${runId}`,
        sku: `ATTR-${runId}`,
        brand: "Robot",
        category: "Pruebas",
        retailPrice: 1000,
        costPrice: 400,
      },
    });
    productId = producto.id;

    await prisma.stock.create({
      data: { productId, branchId, quantity: 500 },
    });

    const [cliente, interno] = await Promise.all([
      prisma.customer.create({
        data: { name: `Cliente Attr ${runId}`, document: `DOC${runId}` },
      }),
      prisma.customer.create({
        data: { name: `Interno Attr ${runId}`, type: "INTERNAL" },
      }),
    ]);
    clienteId = cliente.id;
    clienteInternoId = interno.id;

    terminalId = await testTerminalFor(branchId);

    const caja = await prisma.cashRegister.create({
      data: {
        branchId,
        terminalId,
        userId: adminId,
        initialBalance: 10000,
        status: "OPEN",
      },
    });
    cashRegisterId = caja.id;
  });

  afterAll(async () => {
    const userIds = [adminId, empleadoId];
    await prisma.auditLog.deleteMany({ where: { branchId } });
    await prisma.payment.deleteMany({ where: { branchId } });
    await prisma.saleItem.deleteMany({ where: { saleId: { in: ventasCreadas } } });
    await prisma.internalReceipt.deleteMany({ where: { branchId } });
    await prisma.movement.deleteMany({ where: { branchId } });
    await prisma.sale.deleteMany({ where: { branchId } });
    await prisma.idempotencyRecord.deleteMany({
      where: { key: { startsWith: `attr-${runId}` } },
    });
    await prisma.cashRegister.deleteMany({ where: { branchId } });
    await prisma.posOperatorSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.terminal.deleteMany({ where: { branchId } });
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.customer.deleteMany({
      where: { id: { in: [clienteId, clienteInternoId] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otraSucursalId] } } });
    await prisma.$disconnect();
  });

  // ══════════════════════════════════════════════════════════════════════
  // ATRIBUCIÓN
  // ══════════════════════════════════════════════════════════════════════

  describe("la venta registra quién vendió y quién cobró", () => {
    it("llena vendedor, cajero y sus nombres congelados", async () => {
      const res = await nuevaVenta(empleadoToken);
      expect(res.status).toBe(201);
      ventasCreadas.push(res.body.data.id);

      const venta = await prisma.sale.findUnique({ where: { id: res.body.data.id } });
      expect(venta?.sellerId).toBe(empleadoId);
      expect(venta?.cashierId).toBe(empleadoId);
      expect(venta?.sellerNameSnapshot).toBe(`Empleado Attr ${runId}`);
      expect(venta?.cashierNameSnapshot).toBe(`Empleado Attr ${runId}`);
      // `userId` se conserva por compatibilidad y ahora vale lo mismo que
      // `sellerId`, que es lo que ese campo siempre quiso decir.
      expect(venta?.userId).toBe(empleadoId);
    });

    it("el PAGO queda a nombre del cajero, no del dueño del token", async () => {
      const res = await nuevaVenta(empleadoToken);
      ventasCreadas.push(res.body.data.id);

      const pago = await prisma.payment.findFirst({
        where: { saleId: res.body.data.id },
      });
      // De este campo sale de quién es el faltante en el arqueo.
      expect(pago?.userId).toBe(empleadoId);
    });

    it("🔒 declarar OTRO vendedor en el cuerpo se RECHAZA, no se ignora", async () => {
      const res = await nuevaVenta(empleadoToken, { sellerId: adminId });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe("IDENTITY_MISMATCH");

      // Y no dejó nada: ni venta, ni stock descontado.
      const ventasDelAdmin = await prisma.sale.count({
        where: { branchId, sellerId: adminId },
      });
      expect(ventasDelAdmin).toBe(0);
    });

    it("🔒 declarar otro `userId` tambien se rechaza", async () => {
      const res = await nuevaVenta(empleadoToken, { userId: adminId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("IDENTITY_MISMATCH");
    });

    it("🔒 declarar otro cajero se rechaza", async () => {
      const res = await nuevaVenta(empleadoToken, { cashierId: adminId });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("IDENTITY_MISMATCH");
    });

    it("declarar la identidad CORRECTA no molesta", async () => {
      // Un cliente que manda lo mismo que el servidor resuelve no es un
      // atacante: es un cliente sincronizado. No hay motivo para frenarlo.
      const res = await nuevaVenta(empleadoToken, { sellerId: empleadoId });
      expect(res.status).toBe(201);
      ventasCreadas.push(res.body.data.id);
    });

    it("sin terminal enrolada, la atribución se marca como INFERIDA", async () => {
      const res = await nuevaVenta(empleadoToken);
      ventasCreadas.push(res.body.data.id);

      const venta = await prisma.sale.findUnique({ where: { id: res.body.data.id } });
      // Se sabe quién tenía la sesión abierta, no quién estaba parado en la
      // caja. Decirlo es más honesto que presentarlo como un hecho observado.
      expect(venta?.attributionLegacy).toBe(true);
      expect(venta?.operatorSessionId).toBeNull();
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // CLASE DE OPERACIÓN
  // ══════════════════════════════════════════════════════════════════════

  describe("consumo interno vs venta", () => {
    it("una venta a un cliente normal es SALE", async () => {
      const res = await nuevaVenta(empleadoToken, { customerId: clienteId });
      ventasCreadas.push(res.body.data.id);

      const venta = await prisma.sale.findUnique({ where: { id: res.body.data.id } });
      expect(venta?.kind).toBe("SALE");
    });

    it("una venta a un cliente INTERNAL se marca como consumo interno", async () => {
      const res = await nuevaVenta(empleadoToken, { customerId: clienteInternoId });
      ventasCreadas.push(res.body.data.id);

      const venta = await prisma.sale.findUnique({ where: { id: res.body.data.id } });
      // Hoy el consumo del personal es una venta ordinaria y se cuela en la
      // facturación y en el ranking. Marcarlo permite sacarlo de los reportes.
      expect(venta?.kind).toBe("INTERNAL_CONSUMPTION");
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // HISTORIAL
  // ══════════════════════════════════════════════════════════════════════

  describe("historial", () => {
    const historial = (token: string, query = "") =>
      request(app)
        .get(`/api/sales/history${query}`)
        .set("Authorization", `Bearer ${token}`);

    it("devuelve las ventas con vendedor y cajero resueltos", async () => {
      const res = await historial(adminToken, `?branchId=${branchId}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);

      const venta = res.body.data[0];
      expect(venta.seller).toHaveProperty("name");
      expect(venta.cashier).toHaveProperty("name");
      expect(venta).toHaveProperty("attributionLegacy");
    });

    it("pagina por cursor sin repetir ni saltear filas", async () => {
      const primera = await historial(adminToken, `?branchId=${branchId}&limit=2`);
      expect(primera.body.data).toHaveLength(2);
      expect(primera.body.pageInfo.hasNextPage).toBe(true);

      const segunda = await historial(
        adminToken,
        `?branchId=${branchId}&limit=2&cursor=${encodeURIComponent(primera.body.pageInfo.nextCursor)}`,
      );

      const idsPrimera = primera.body.data.map((v: { id: number }) => v.id);
      const idsSegunda = segunda.body.data.map((v: { id: number }) => v.id);
      // Ninguna venta aparece en las dos páginas.
      expect(idsSegunda.filter((id: number) => idsPrimera.includes(id))).toHaveLength(0);
    });

    it("🔒 el resumen describe el FILTRO COMPLETO, no la página", async () => {
      // Sin esto, la pantalla sólo puede sumar lo que tiene cargado. Con
      // paginación, el encabezado diría "TOTAL: $X" cuando en realidad son las
      // primeras 25 filas de 200 — un número que miente, y que alguien va a
      // leer como lo vendido en el período.
      const [chica, grande] = await Promise.all([
        historial(adminToken, `?branchId=${branchId}&limit=2`),
        historial(adminToken, `?branchId=${branchId}&limit=100`),
      ]);

      expect(chica.body.data).toHaveLength(2);
      expect(grande.body.data.length).toBeGreaterThan(2);
      // El resumen NO cambia con el tamaño de página.
      expect(chica.body.summary).toEqual(grande.body.summary);
      expect(chica.body.summary.count).toBe(grande.body.data.length);
    });

    it("el resumen sí cambia cuando cambia el FILTRO", async () => {
      const [todo, sinInternas] = await Promise.all([
        historial(adminToken, `?branchId=${branchId}&limit=100`),
        historial(adminToken, `?branchId=${branchId}&limit=100&excludeInternal=true`),
      ]);

      expect(sinInternas.body.summary.count).toBeLessThan(todo.body.summary.count);
      expect(sinInternas.body.summary.totalAmount).toBeLessThan(
        todo.body.summary.totalAmount,
      );
    });

    it("filtra por vendedor", async () => {
      const res = await historial(adminToken, `?branchId=${branchId}&sellerId=${empleadoId}`);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const venta of res.body.data) {
        expect(venta.seller.id).toBe(empleadoId);
      }
    });

    it("excluye el consumo interno cuando se lo pide", async () => {
      const res = await historial(adminToken, `?branchId=${branchId}&excludeInternal=true`);
      for (const venta of res.body.data) {
        expect(venta.kind).not.toBe("INTERNAL_CONSUMPTION");
      }
    });

    it("filtra Consumidor Final, que es la AUSENCIA de cliente", async () => {
      const res = await historial(adminToken, `?branchId=${branchId}&consumidorFinal=true`);
      expect(res.body.data.length).toBeGreaterThan(0);
      for (const venta of res.body.data) {
        expect(venta.customer).toBeNull();
        expect(venta.isConsumidorFinal).toBe(true);
      }
    });

    it("filtra por rango de importe", async () => {
      const res = await historial(adminToken, `?branchId=${branchId}&minAmount=999&maxAmount=1001`);
      for (const venta of res.body.data) {
        expect(Number(venta.totalAmount)).toBeGreaterThanOrEqual(999);
        expect(Number(venta.totalAmount)).toBeLessThanOrEqual(1001);
      }
    });

    it("busca por número de venta", async () => {
      const alguna = ventasCreadas[0]!;
      const res = await historial(adminToken, `?search=${alguna}`);
      expect(res.body.data.some((v: { id: number }) => v.id === alguna)).toBe(true);
    });

    it("🔒 un empleado NO puede ver la sucursal ajena pidiéndola por parámetro", async () => {
      // Pedir una sucursal que no le corresponde no ensancha el alcance: se
      // intersecta con lo permitido y el resultado queda vacío.
      const res = await historial(empleadoToken, `?branchId=${otraSucursalId}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });

    it("respeta el tope de página aunque pidan 100.000", async () => {
      const res = await historial(adminToken, `?branchId=${branchId}&limit=100000`);
      expect(res.body.pageInfo.pageSize).toBeLessThanOrEqual(100);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // COSTOS
  // ══════════════════════════════════════════════════════════════════════

  describe("🔒 visibilidad del costo", () => {
    it("el ADMIN ve el costo en el detalle", async () => {
      const saleId = ventasCreadas[0]!;
      const res = await request(app)
        .get(`/api/sales/${saleId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.items[0]).toHaveProperty("unitCost");
      expect(res.body.data.items[0].unitCost).not.toBeNull();
    });

    it("el empleado NO recibe el costo — se omite del payload, no se esconde", async () => {
      const saleId = ventasCreadas[0]!;
      const res = await request(app)
        .get(`/api/sales/${saleId}`)
        .set("Authorization", `Bearer ${empleadoToken}`);

      expect(res.status).toBe(200);
      // La clave NO viaja. Ocultarla con CSS dejaría el dato a un clic de las
      // herramientas de desarrollo.
      expect(res.body.data.items[0].unitCost).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain("unitCost");
    });

    it("las opciones de filtro dicen si puede ver costos", async () => {
      const [admin, empleado] = await Promise.all([
        request(app)
          .get("/api/sales/history/filters")
          .set("Authorization", `Bearer ${adminToken}`),
        request(app)
          .get("/api/sales/history/filters")
          .set("Authorization", `Bearer ${empleadoToken}`),
      ]);

      expect(admin.body.data.canViewCosts).toBe(true);
      expect(empleado.body.data.canViewCosts).toBe(false);
    });
  });
});

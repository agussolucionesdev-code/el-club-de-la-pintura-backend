/**
 * Idempotencia de ventas: exactamente una vez, aunque el cliente reintente.
 *
 * Cubre las cinco conductas exigidas y los escenarios de recuperación ante
 * caída. Todo con requests reales contra la base de tests.
 *
 * En esta fase el alcance es (usuario, sucursal) — `scopeVersion = 1`. El
 * modelo `Terminal` todavía no existe y no se inventa identidad de terminal a
 * partir de datos del navegador, así que acá NO hay tests de alcance por
 * terminal ni por sesión de operador: llegan con sus modelos en las Fases 3 y 4.
 */

import request from "supertest";
import bcrypt from "bcrypt";
import { IdempotencyStatus } from "@prisma/client";

import app from "../src/app";
import prisma from "../src/config/db";
import { testTerminalFor } from "./helpers/terminal";
import { generateTestToken } from "./helpers/auth";
import {
  fingerprintOf,
  userBranchScope,
  withIdempotency,
} from "../src/utils/idempotency.utils";

describe("Idempotencia de ventas", () => {
  const runId = Date.now();
  const emailA = `robot_idem_a_${runId}@elclub.com`;
  const emailB = `robot_idem_b_${runId}@elclub.com`;

  let tokenA = "";
  let tokenB = "";
  let userAId = 0;
  let userBId = 0;
  let branchId = 0;
  let cashRegisterId = 0;
  let productId = 0;

  const usedKeys: string[] = [];
  const newKey = (label: string) => {
    const key = `idem-${label}-${runId}-${Math.random().toString(36).slice(2, 10)}`;
    usedKeys.push(key);
    return key;
  };

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `Sucursal Idem ${runId}`, location: "Mostrador" },
    });
    branchId = branch.id;

    const password = await bcrypt.hash("supersecretpassword", 10);
    const [userA, userB] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Robot Idem A ${runId}`,
          email: emailA,
          password,
          role: "ENCARGADO",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Robot Idem B ${runId}`,
          email: emailB,
          password,
          role: "ENCARGADO",
          branches: { connect: [{ id: branchId }] },
        },
      }),
    ]);
    userAId = userA.id;
    userBId = userB.id;

    const product = await prisma.product.create({
      data: {
        sku: `IDEM-${runId}`,
        name: `Producto Idem ${runId}`,
        brand: "Robot",
        category: "Pruebas",
        costPrice: 100,
        retailPrice: 500,
      },
    });
    productId = product.id;

    await prisma.stock.create({
      data: { productId, branchId, quantity: 1000, minStock: 0 },
    });

    const cashRegister = await prisma.cashRegister.create({
      data: { terminalId: await testTerminalFor(branchId), initialBalance: 100, status: "OPEN", userId: userAId, branchId },
    });
    cashRegisterId = cashRegister.id;

    tokenA = generateTestToken({ userId: userAId, role: "ENCARGADO", branchIds: [branchId] });
    tokenB = generateTestToken({ userId: userBId, role: "ENCARGADO", branchIds: [branchId] });
  });

  afterAll(async () => {
    const sales = await prisma.sale.findMany({ where: { branchId }, select: { id: true } });
    const saleIds = sales.map((sale) => sale.id);

    await prisma.idempotencyRecord.deleteMany({ where: { key: { in: usedKeys } } });
    await prisma.internalReceipt.deleteMany({ where: { branchId } });
    await prisma.payment.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    await prisma.movement.deleteMany({ where: { productId } });
    await prisma.cashRegister.deleteMany({ where: { id: cashRegisterId } });
    await prisma.stock.deleteMany({ where: { productId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { email: { in: [emailA, emailB] } } });
    // El helper crea una terminal por sucursal; hay que borrarla ANTES
    // que la sucursal o la clave foránea lo impide.
    await prisma.terminal.deleteMany({ where: { code: { startsWith: "TEST-" } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  const salePayload = (totalAmount = 500, quantity = 1) => ({
    branchId,
    cashRegisterId,
    paymentMethod: "CASH",
    totalAmount,
    items: [{ productId, quantity, unitPrice: 500, subtotal: 500 * quantity }],
  });

  const sell = (key: string | null, body: object, token = tokenA) => {
    const req = request(app)
      .post("/api/sales")
      .set("Authorization", `Bearer ${token}`);
    if (key) req.set("Idempotency-Key", key);
    return req.send(body);
  };

  // ── Las cinco conductas exigidas ─────────────────────────────────────────

  it("misma clave, mismo alcance, misma huella → devuelve el resultado original sin reejecutar", async () => {
    const key = newKey("replay");
    const body = salePayload();

    const first = await sell(key, body);
    expect(first.status).toBe(201);
    const saleId = first.body.data.id;

    const second = await sell(key, body);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    // LA MISMA venta, no una nueva.
    expect(second.body.data.id).toBe(saleId);

    const sales = await prisma.sale.findMany({ where: { idempotencyKey: key } });
    expect(sales).toHaveLength(1);
  });

  it("misma clave con OTRA huella → 409, y no reutiliza el resultado anterior", async () => {
    const key = newKey("mismatch");

    const first = await sell(key, salePayload(500, 1));
    expect(first.status).toBe(201);

    const second = await sell(key, salePayload(1000, 2));
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH");
    // No devolvió la venta vieja disfrazada de éxito.
    expect(second.body.data).toBeUndefined();

    const sales = await prisma.sale.findMany({ where: { idempotencyKey: key } });
    expect(sales).toHaveLength(1);
  });

  it("misma clave desde OTRO usuario → 409 por alcance", async () => {
    const key = newKey("scope");
    const body = salePayload();

    expect((await sell(key, body, tokenA)).status).toBe(201);

    const intruso = await sell(key, body, tokenB);
    expect(intruso.status).toBe(409);
    expect(intruso.body.code).toBe("IDEMPOTENCY_SCOPE_MISMATCH");
  });

  it("dos requests concurrentes con la misma clave → exactamente un commit", async () => {
    const key = newKey("concurrent");
    const body = salePayload();

    const results = await Promise.all([sell(key, body), sell(key, body)]);
    const created = results.filter((res) => res.status === 201);
    const otros = results.filter((res) => res.status !== 201);

    expect(created).toHaveLength(1);
    expect(otros).toHaveLength(1);
    // El segundo o bien reprodujo el resultado (200) o fue rechazado por lease
    // vigente (409). Las dos son correctas; lo que NO puede haber es dos ventas.
    expect([200, 409]).toContain(otros[0]?.status);

    const sales = await prisma.sale.findMany({ where: { idempotencyKey: key } });
    expect(sales).toHaveLength(1);
  });

  it("una transacción fallida no deja un falso éxito: la clave queda reutilizable", async () => {
    const key = newKey("failed");

    // Se pide MUCHO más stock del que hay. El total va coherente con la
    // cantidad (5000 × $500) para que falle por STOCK y no por el contraste de
    // totales que introdujo la Fase 2.
    const pedidoEnorme = salePayload(5000 * 500, 5000);

    const fallida = await sell(key, pedidoEnorme);
    expect(fallida.status).toBe(400);
    expect(fallida.body.error).toMatch(/[Ss]tock insuficiente/u);

    const record = await prisma.idempotencyRecord.findUnique({ where: { key } });
    expect(record?.status).toBe(IdempotencyStatus.FAILED);

    // No quedó venta a medias.
    expect(await prisma.sale.count({ where: { idempotencyKey: key } })).toBe(0);

    // Con la MISMA huella se puede reintentar. Como la huella incluye el
    // payload, hay que repetir el mismo body — que ahora sí tiene stock.
    await prisma.stock.update({
      where: { productId_branchId: { productId, branchId } },
      data: { quantity: 10_000 },
    });
    const reintento = await sell(key, pedidoEnorme);
    expect(reintento.status).toBe(201);

    // Se deja el stock como estaba para los tests que siguen.
    await prisma.stock.update({
      where: { productId_branchId: { productId, branchId } },
      data: { quantity: 1000 },
    });
  });

  // ── Recuperación ante caída ──────────────────────────────────────────────

  it("un intento rancio NO commitea si otro le tomó el lease vencido", async () => {
    const key = newKey("stale");
    const scope = userBranchScope(userAId, branchId);
    const payload = { demo: true };

    // A arranca, y mientras trabaja se le vence el lease y B se lo lleva.
    const resultado = await withIdempotency({ key, payload, scope }, async (tx) => {
      // Simula el vencimiento y la toma por parte de otro intento.
      await prisma.idempotencyRecord.update({
        where: { key },
        data: { attemptId: "otro-intento", lockedUntil: new Date(Date.now() + 30_000) },
      });

      // A hace su trabajo igual, sin saber que ya no es dueño.
      await tx.branch.create({
        data: { name: `Fantasma ${key}`, location: "no debería existir" },
      });

      return { value: null, resultType: "demo", resultId: "1", httpStatus: 201 };
    });

    expect(resultado.kind).toBe("conflict");

    // Lo importante: el trabajo de A se revirtió entero junto con la marca.
    const fantasma = await prisma.branch.findFirst({
      where: { name: `Fantasma ${key}` },
    });
    expect(fantasma).toBeNull();
  });

  it("un lease VIGENTE no se le quita a nadie", async () => {
    const key = newKey("lease-vivo");
    const scope = userBranchScope(userAId, branchId);

    await prisma.idempotencyRecord.create({
      data: {
        key,
        fingerprint: fingerprintOf({ x: 1 }),
        scopeVersion: scope.version,
        scopeHash: (await import("node:crypto"))
          .createHash("sha256")
          .update(`v${scope.version}:${scope.parts.join(":")}`)
          .digest("hex"),
        status: IdempotencyStatus.IN_FLIGHT,
        attemptId: "dueño-original",
        lockedUntil: new Date(Date.now() + 30_000),
      },
    });

    let corrio = false;
    const resultado = await withIdempotency({ key, payload: { x: 1 }, scope }, async () => {
      corrio = true;
      return { value: null, resultType: "demo", resultId: "1", httpStatus: 201 };
    });

    expect(resultado.kind).toBe("conflict");
    expect(corrio).toBe(false); // ni siquiera se intentó
  });

  it("un lease VENCIDO sí se puede tomar", async () => {
    const key = newKey("lease-vencido");
    const scope = userBranchScope(userAId, branchId);
    const crypto = await import("node:crypto");

    await prisma.idempotencyRecord.create({
      data: {
        key,
        fingerprint: fingerprintOf({ x: 1 }),
        scopeVersion: scope.version,
        scopeHash: crypto
          .createHash("sha256")
          .update(`v${scope.version}:${scope.parts.join(":")}`)
          .digest("hex"),
        status: IdempotencyStatus.IN_FLIGHT,
        attemptId: "proceso-muerto",
        lockedUntil: new Date(Date.now() - 1000), // ya venció
      },
    });

    const resultado = await withIdempotency({ key, payload: { x: 1 }, scope }, async () => ({
      value: "listo",
      resultType: "demo",
      resultId: "42",
      httpStatus: 201,
    }));

    expect(resultado.kind).toBe("executed");
  });

  it("si el registro de idempotencia desaparece, la venta NO se duplica", async () => {
    // Escenario real: purga por error, borrado a mano, base restaurada de un
    // backup viejo. El IdempotencyRecord ya no está, pero la venta sí.
    const key = newKey("sin-registro");
    const body = salePayload();

    const primera = await sell(key, body);
    expect(primera.status).toBe(201);
    const saleId = primera.body.data.id;

    // Se borra el registro, dejando sólo la columna única de `Sale`.
    await prisma.idempotencyRecord.delete({ where: { key } });

    const reintento = await sell(key, body);

    // El índice único de Sale.idempotencyKey frena el duplicado, y la respuesta
    // es la venta original — no un error crudo de Prisma.
    expect(reintento.status).toBe(200);
    expect(reintento.body.replayed).toBe(true);
    expect(reintento.body.data.id).toBe(saleId);

    expect(await prisma.sale.count({ where: { idempotencyKey: key } })).toBe(1);
  });

  it("la huella no depende del orden de las claves del JSON", () => {
    expect(fingerprintOf({ a: 1, b: { c: 2, d: 3 } })).toBe(
      fingerprintOf({ b: { d: 3, c: 2 }, a: 1 }),
    );
    expect(fingerprintOf({ a: 1 })).not.toBe(fingerprintOf({ a: 2 }));
  });

  it("una clave con formato inválido se rechaza con 400", async () => {
    const res = await sell("corta", salePayload());
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Idempotency-Key/u);
  });

  it("sin clave la venta sigue funcionando (compatibilidad de esta release)", async () => {
    const res = await sell(null, salePayload());
    expect(res.status).toBe(201);
    expect(res.body.data.idempotencyKey).toBeNull();
  });
});

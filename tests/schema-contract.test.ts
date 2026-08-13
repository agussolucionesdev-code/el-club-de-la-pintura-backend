/**
 * Contrato de validación: qué llega realmente al controlador.
 *
 * El middleware `validate` llamaba a `schema.parse(...)` y **descartaba el
 * resultado**. Validaba, pero no aplicaba nada. Tres consecuencias que
 * estuvieron en producción sin que nadie las viera:
 *
 *   · Las claves no declaradas sobrevivían → `createSale` leía `item.unitCost`,
 *     un campo que su schema ni menciona, y persistía un costo del navegador.
 *   · Ningún `.default()` se aplicaba.
 *   · Ninguna coerción `z.coerce` se aplicaba.
 *
 * El arreglo se activa MÓDULO POR MÓDULO (`assignParsed`), no de golpe: 11 de
 * los 15 módulos usan defaults o coerciones que hoy no corren, y activarlos sin
 * verificar cambiaría su comportamiento en silencio.
 *
 * Estos tests fijan el contrato del primer módulo migrado —`sale`— y dejan
 * documentado, con una prueba que falla si alguien lo rompe, que el resto sigue
 * en el comportamiento viejo a propósito.
 */

import request from "supertest";
import bcrypt from "bcrypt";
import express from "express";
import { z } from "zod";

import app from "../src/app";
import prisma from "../src/config/db";
import { testTerminalFor } from "./helpers/terminal";
import { generateTestToken } from "./helpers/auth";
import { validate } from "../src/middlewares/validate.middleware";

describe("Contrato de validación con Zod", () => {
  describe("el middleware, aislado", () => {
    const schema = z.object({
      body: z.object({
        declarado: z.string(),
        conDefault: z.string().default("valor-por-defecto"),
        coercionado: z.coerce.number().optional(),
      }),
    });

    /** Monta un Express mínimo que devuelve el body tal como lo ve el handler. */
    const montar = (opciones?: { assignParsed?: boolean }) => {
      const server = express();
      server.use(express.json());
      server.post("/probar", validate(schema, opciones), (req, res) => {
        res.json({ body: req.body });
      });
      return server;
    };

    const payload = {
      declarado: "hola",
      coercionado: "42",
      noDeclarado: "esto no debería llegar",
    };

    it("SIN assignParsed: las claves no declaradas sobreviven — el comportamiento viejo", async () => {
      const res = await request(montar()).post("/probar").send(payload);
      expect(res.status).toBe(200);
      // Este es exactamente el agujero por el que se colaba `unitCost`.
      expect(res.body.body.noDeclarado).toBe("esto no debería llegar");
      // Y los defaults nunca llegaban al controlador.
      expect(res.body.body.conDefault).toBeUndefined();
      // Ni las coerciones: sigue siendo el string crudo.
      expect(res.body.body.coercionado).toBe("42");
    });

    it("CON assignParsed: se descarta lo no declarado y se aplican defaults y coerciones", async () => {
      const res = await request(montar({ assignParsed: true }))
        .post("/probar")
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.body.noDeclarado).toBeUndefined();
      expect(res.body.body.conDefault).toBe("valor-por-defecto");
      expect(res.body.body.coercionado).toBe(42); // número, no string
    });

    it("un cuerpo inválido sigue dando 400 con el detalle por campo", async () => {
      const res = await request(montar({ assignParsed: true }))
        .post("/probar")
        .send({ coercionado: "no-es-numero" });
      expect(res.status).toBe(400);
      expect(res.body.details.some((d: { path: string }) => d.path.includes("declarado"))).toBe(
        true,
      );
    });
  });

  describe("módulo `sale`: primer migrado", () => {
    const runId = Date.now();
    const email = `robot_contract_${runId}@elclub.com`;

    let token = "";
    let userId = 0;
    let branchId = 0;
    let cashRegisterId = 0;
    let productId = 0;

    beforeAll(async () => {
      const branch = await prisma.branch.create({
        data: { name: `Sucursal Contract ${runId}`, location: "x" },
      });
      branchId = branch.id;

      const user = await prisma.user.create({
        data: {
          name: `Robot Contract ${runId}`,
          email,
          password: await bcrypt.hash("supersecretpassword", 10),
          role: "ENCARGADO",
          branches: { connect: [{ id: branchId }] },
        },
      });
      userId = user.id;

      const product = await prisma.product.create({
        data: {
          sku: `CTR-${runId}`,
          name: `Producto Contract ${runId}`,
          brand: "Robot",
          category: "Pruebas",
          costPrice: 300,
          retailPrice: 900,
        },
      });
      productId = product.id;

      await prisma.stock.create({ data: { productId, branchId, quantity: 100, minStock: 0 } });
      const cashRegister = await prisma.cashRegister.create({
        data: { terminalId: await testTerminalFor(branchId), initialBalance: 1000, status: "OPEN", userId, branchId },
      });
      cashRegisterId = cashRegister.id;

      token = generateTestToken({ userId, role: "ENCARGADO", branchIds: [branchId] });
    });

    afterAll(async () => {
      const sales = await prisma.sale.findMany({ where: { branchId }, select: { id: true } });
      const saleIds = sales.map((s) => s.id);
      await prisma.internalReceipt.deleteMany({ where: { branchId } });
      await prisma.payment.deleteMany({ where: { saleId: { in: saleIds } } });
      await prisma.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });
      await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
      await prisma.movement.deleteMany({ where: { branchId } });
      await prisma.cashRegister.deleteMany({ where: { id: cashRegisterId } });
      await prisma.stock.deleteMany({ where: { productId } });
      await prisma.product.deleteMany({ where: { id: productId } });
      await prisma.user.deleteMany({ where: { email } });
      // El helper crea una terminal por sucursal; hay que borrarla ANTES
      // que la sucursal o la clave foránea lo impide.
      await prisma.terminal.deleteMany({ where: { code: { startsWith: "TEST-" } } });
      await prisma.branch.deleteMany({ where: { id: branchId } });
      await prisma.$disconnect();
    });

    it("un campo inyectado no llega siquiera al controlador", async () => {
      const res = await request(app)
        .post("/api/sales")
        .set("Authorization", `Bearer ${token}`)
        .send({
          branchId,
          cashRegisterId,
          paymentMethod: "CASH",
          totalAmount: 900,
          items: [
            {
              productId,
              quantity: 1,
              // Campos hostiles que el schema NO declara.
              unitCost: 0.01,
              campoInventado: "chau",
            },
          ],
        });

      expect(res.status).toBe(201);

      // El costo es el de la base, no el inyectado. Ahora se descarta en el
      // BORDE, no sólo se ignora en la lógica: defensa en profundidad.
      const item = await prisma.saleItem.findFirstOrThrow({
        where: { saleId: res.body.data.id },
      });
      expect(Number(item.unitCost)).toBe(300);
    });

    it("una cantidad no entera se rechaza en el borde, no en el stock", async () => {
      const res = await request(app)
        .post("/api/sales")
        .set("Authorization", `Bearer ${token}`)
        .send({
          branchId,
          cashRegisterId,
          paymentMethod: "CASH",
          totalAmount: 900,
          items: [{ productId, quantity: 1.5 }],
        });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/entero/u);
    });
  });
});

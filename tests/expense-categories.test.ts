/**
 * Categorías de gasto: lista cerrada, administrable por el dueño.
 *
 * ── Qué se está defendiendo ─────────────────────────────────────────────────
 *
 * `Expense.category` era texto libre y la pantalla tenía seis categorías con
 * sus colores cableadas en TypeScript. Consecuencias medidas en los datos
 * reales: conviven "LIMPIEZA", "LOGISTICA" y "ALQUILER" —que no están en ese
 * mapa— y salen en gris, sin etiqueta, mostrando la clave cruda al usuario. Y
 * "Limpieza" y "LIMPIEZA" cuentan como dos categorías distintas, partiendo el
 * gráfico en pedazos que deberían ser uno.
 *
 * Ahora la lista vive en la base con su color, sólo el dueño la administra, y
 * nada que tenga historia se borra: se desactiva, para que el pasado conserve
 * su nombre.
 */

import bcrypt from "bcrypt";
import request from "supertest";

import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";
import { testTerminalFor } from "./helpers/terminal";

describe("Categorías de gasto", () => {
  const runId = Date.now();
  let branchId = 0;
  let adminId = 0;
  let encargadoId = 0;
  let adminToken = "";
  let encargadoToken = "";
  let cajaId = 0;
  const creadas: number[] = [];

  beforeAll(async () => {
    branchId = (
      await prisma.branch.create({
        data: { name: `Cat-${runId}`, location: "Test", isActive: true },
      })
    ).id;

    const hash = await bcrypt.hash("Password123!", 10);
    adminId = (
      await prisma.user.create({
        data: {
          name: `CatAdmin-${runId}`,
          email: `cat-admin-${runId}@test.local`,
          password: hash,
          role: "ADMIN",
          branches: { connect: [{ id: branchId }] },
        },
      })
    ).id;
    encargadoId = (
      await prisma.user.create({
        data: {
          name: `CatEnc-${runId}`,
          email: `cat-enc-${runId}@test.local`,
          password: hash,
          role: "ENCARGADO",
          branches: { connect: [{ id: branchId }] },
        },
      })
    ).id;

    adminToken = generateTestToken({ userId: adminId, role: "ADMIN", branchIds: [branchId] });
    encargadoToken = generateTestToken({
      userId: encargadoId,
      role: "ENCARGADO",
      branchIds: [branchId],
    });

    cajaId = (
      await prisma.cashRegister.create({
        data: {
          branchId,
          terminalId: await testTerminalFor(branchId),
          userId: adminId,
          initialBalance: 200000,
          status: "OPEN",
        },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.expense.deleteMany({ where: { branchId } });
    await prisma.expenseCategory.deleteMany({ where: { id: { in: creadas } } });
    await prisma.cashRegister.deleteMany({ where: { id: cajaId } });
    await prisma.terminal.deleteMany({ where: { branchId } });
    await prisma.user.deleteMany({ where: { id: { in: [adminId, encargadoId] } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  describe("la lista", () => {
    it("trae las seis del sistema, cada una con su color", async () => {
      const res = await request(app)
        .get("/api/expenses/categories")
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const porClave = new Map(
        (res.body.data as { key: string; color: string; isSystem: boolean }[]).map((c) => [
          c.key,
          c,
        ]),
      );
      // Los colores son EXACTAMENTE los que tenía cableados el frontend: al
      // desplegar, nada cambia de aspecto.
      expect(porClave.get("LOGISTICS")).toMatchObject({ color: "#f59e0b", isSystem: true });
      expect(porClave.get("MAINTENANCE")).toMatchObject({ color: "#f43f5e", isSystem: true });
      expect(porClave.get("OTHER")).toMatchObject({ color: "#64748b", isSystem: true });
      // Y las del rubro que se agregaron después.
      expect(porClave.get("INSUMOS")).toMatchObject({ color: "#14b8a6", isSystem: true });
    });

    it("el encargado también la ve: la necesita para cargar y para leer", async () => {
      const res = await request(app)
        .get("/api/expenses/categories")
        .set("Authorization", `Bearer ${encargadoToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(6);
    });
  });

  describe("alta", () => {
    it("sólo el dueño puede crear", async () => {
      const res = await request(app)
        .post("/api/expenses/categories")
        .set("Authorization", `Bearer ${encargadoToken}`)
        .send({ label: "Publicidad", color: "#ec4899" });
      expect(res.status).toBe(403);
    });

    it("el dueño crea una categoría y el sistema le arma la clave", async () => {
      const res = await request(app)
        .post("/api/expenses/categories")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ label: "Fletes y logística extra", color: "#ec4899" });

      expect(res.status).toBe(201);
      // La clave se genera sola, sin acentos ni espacios: nadie que administre
      // una pinturería tiene por qué saber qué es una clave estable.
      expect(res.body.data.key).toBe("FLETES_Y_LOGISTICA_EXTRA");
      expect(res.body.data.color).toBe("#ec4899");
      expect(res.body.data.isSystem).toBe(false);
      creadas.push(res.body.data.id);
    });

    it("rechaza un color que no sea hexadecimal", async () => {
      // El color va directo a un `style` y a los gráficos: si entra basura, se
      // rompe el render, no el dato.
      for (const color of ["rojo", "#fff", "javascript:alert(1)", "#gggggg"]) {
        const res = await request(app)
          .post("/api/expenses/categories")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ label: `Prueba ${color}`, color });
        expect(res.status).toBe(400);
      }
    });

    it("rechaza nombres vacíos o demasiado largos", async () => {
      for (const label of ["", "a", "x".repeat(41)]) {
        const res = await request(app)
          .post("/api/expenses/categories")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({ label, color: "#123456" });
        expect(res.status).toBe(400);
      }
    });

    it("no crea una gemela: si ya existe activa, avisa", async () => {
      // "Fletes y logística" existe como LOGISTICS. Escribirlo generaría la
      // clave FLETES_Y_LOGISTICA —distinta— y nacerían dos categorías que el
      // usuario ve idénticas.
      const res = await request(app)
        .post("/api/expenses/categories")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ label: "Fletes y logística", color: "#000000" });
      expect(res.status).toBe(409);
    });

    it("una categoría desactivada se REACTIVA en vez de duplicarse", async () => {
      // "Sueldos" quedó desactivada al sacarla del módulo. Si el dueño la
      // vuelve a escribir, lo que quiere es recuperarla, no tener dos.
      const res = await request(app)
        .post("/api/expenses/categories")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ label: "Sueldos", color: "#10b981" });

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/se volvió a activar/u);
      expect(res.body.data.key).toBe("SALARY");

      // Se deja como estaba para no ensuciar el resto de la suite.
      await prisma.expenseCategory.update({
        where: { key: "SALARY" },
        data: { isActive: false },
      });
    });
  });

  describe("edición", () => {
    it("renombrar cambia la etiqueta pero NO la clave", async () => {
      // Si cambiara la clave, todos los gastos ya cargados quedarían huérfanos.
      const id = creadas[0]!;
      const antes = await prisma.expenseCategory.findUnique({ where: { id } });

      const res = await request(app)
        .patch(`/api/expenses/categories/${id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ label: "Fletes especiales" });

      expect(res.status).toBe(200);
      expect(res.body.data.label).toBe("Fletes especiales");
      expect(res.body.data.key).toBe(antes!.key);
    });

    it("una categoría del sistema no se puede desactivar", async () => {
      const otros = await prisma.expenseCategory.findUnique({ where: { key: "OTHER" } });
      const res = await request(app)
        .patch(`/api/expenses/categories/${otros!.id}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ isActive: false });
      expect(res.status).toBe(409);
    });
  });

  describe("baja", () => {
    it("una categoría CON gastos se desactiva, no se borra", async () => {
      // Borrarla dejaría esos gastos sin nombre ni color para siempre.
      const nueva = await request(app)
        .post("/api/expenses/categories")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ label: "Con historia", color: "#22d3ee" });
      const id = nueva.body.data.id as number;
      creadas.push(id);

      await prisma.expense.create({
        data: {
          amount: 1500,
          reason: "Gasto con esa categoría",
          category: nueva.body.data.key,
          cashRegisterId: cajaId,
          userId: adminId,
          branchId,
        },
      });

      const res = await request(app)
        .delete(`/api/expenses/categories/${id}`)
        .set("Authorization", `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/se desactivó/u);
      const sigue = await prisma.expenseCategory.findUnique({ where: { id } });
      expect(sigue).not.toBeNull();
      expect(sigue!.isActive).toBe(false);
    });

    it("una categoría del sistema no se borra ni vacía", async () => {
      const logistica = await prisma.expenseCategory.findUnique({
        where: { key: "LOGISTICS" },
      });
      const res = await request(app)
        .delete(`/api/expenses/categories/${logistica!.id}`)
        .set("Authorization", `Bearer ${adminToken}`);
      expect(res.status).toBe(409);
    });
  });

  describe("qué NO vive en Gastos", () => {
    it("pagos a proveedor y sueldos ya no se pueden cargar acá", async () => {
      // Gastos registra lo que sale del cajón en la operación diaria. Un pago a
      // proveedor tiene su lugar en Compras y un sueldo en Liquidaciones;
      // tenerlos también acá invita a cargar la misma plata dos veces, y a
      // partir del segundo mes nadie sabe cuál de los dos números es el bueno.
      for (const key of ["SUPPLIER_PAYMENT", "SALARY"]) {
        const res = await request(app)
          .post("/api/expenses")
          .set("Authorization", `Bearer ${adminToken}`)
          .send({
            amount: 1000,
            reason: "No debería entrar",
            category: key,
            type: "VARIABLE",
            branchId,
            cashRegisterId: cajaId,
          });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/desactivada/u);
      }
    });

    it("siguen existiendo para no dejar sin nombre al histórico", async () => {
      // Desactivadas, no borradas: si algún día se cargó un gasto con ellas,
      // ese gasto conserva su etiqueta y su color.
      const res = await request(app)
        .get("/api/expenses/categories")
        .set("Authorization", `Bearer ${adminToken}`);

      const porClave = new Map(
        (res.body.data as { key: string; isActive: boolean }[]).map((c) => [c.key, c]),
      );
      expect(porClave.get("SUPPLIER_PAYMENT")).toMatchObject({ isActive: false });
      expect(porClave.get("SALARY")).toMatchObject({ isActive: false });
    });
  });

  describe("el gasto valida contra la lista", () => {
    it("una categoría inventada ya NO entra", async () => {
      // Éste es el punto de todo: antes cualquier texto era una categoría nueva.
      const res = await request(app)
        .post("/api/expenses")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          amount: 1000,
          reason: "Gasto con categoría inventada",
          category: "CATEGORIA_QUE_NO_EXISTE",
          type: "VARIABLE",
          branchId,
          cashRegisterId: cajaId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no existe|Elegí una de la lista/u);
    });

    it("una categoría DESACTIVADA tampoco entra", async () => {
      const desactivada = await prisma.expenseCategory.findFirst({
        where: { isActive: false, isSystem: false },
      });
      if (!desactivada) return; // por si el orden de los tests cambia

      const res = await request(app)
        .post("/api/expenses")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          amount: 1000,
          reason: "Gasto con categoría vieja",
          category: desactivada.key,
          type: "VARIABLE",
          branchId,
          cashRegisterId: cajaId,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/desactivada/u);
    });

    it("una categoría de la lista SÍ entra", async () => {
      const res = await request(app)
        .post("/api/expenses")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({
          amount: 2500,
          reason: "Flete de la mañana",
          category: "LOGISTICS",
          type: "VARIABLE",
          branchId,
          cashRegisterId: cajaId,
        });

      expect([200, 201]).toContain(res.status);
    });
  });
});

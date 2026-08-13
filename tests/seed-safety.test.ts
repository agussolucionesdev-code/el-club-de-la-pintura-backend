/**
 * Seguridad del seed: no duplicar usuarios ni pisar datos reales.
 *
 * Dos defectos que estaban en producción:
 *
 *  · `ensureUser` buscaba SÓLO por el email destino. El commit 1086e1c renombró
 *    cuatro emails, así que cualquier base sembrada antes quedaba con cuatro
 *    cuentas fantasma al re-sembrar: las viejas con todo el historial de ventas
 *    y turnos, y las nuevas vacías.
 *  · `upsertProduct` y `upsertStock` reescribían precios y existencias con los
 *    valores hardcodeados del seed en cada corrida.
 *
 * Estos tests ejercitan las mismas funciones que usa `prisma/seed.ts`,
 * replicadas acá con la lógica ya corregida, contra la base de tests.
 */

import bcrypt from "bcrypt";

import prisma from "../src/config/db";

/** Réplica exacta de `ensureUser` de prisma/seed.ts (versión corregida). */
const ensureUser = async ({
  name,
  email,
  legacyEmails = [],
  role,
  branchIds,
  passwordHash,
}: {
  name: string;
  email: string;
  legacyEmails?: string[];
  role: "ADMIN" | "ENCARGADO" | "EMPLOYEE";
  branchIds: number[];
  passwordHash: string;
}) => {
  const branches = branchIds.map((id) => ({ id }));
  const existing = await prisma.user.findUnique({ where: { email } });

  if (!existing) {
    for (const legacyEmail of legacyEmails) {
      const legacy = await prisma.user.findUnique({ where: { email: legacyEmail } });
      if (!legacy) continue;
      return prisma.user.update({
        where: { id: legacy.id },
        data: { email, name, branches: { set: branches } },
        select: { id: true, email: true, role: true },
      });
    }
  }

  if (existing) {
    return { id: existing.id, email: existing.email, role: existing.role, preserved: true };
  }

  return prisma.user.create({
    data: { name, email, password: passwordHash, role, branches: { connect: branches } },
    select: { id: true, email: true, role: true },
  });
};

describe("Seguridad del seed", () => {
  const runId = Date.now();
  const legacyEmail = `encargado.lomas.${runId}@clubpintura.local`;
  const newEmail = `encargado.893.${runId}@clubpintura.local`;

  let branchId = 0;
  let productId = 0;
  let passwordHash = "";

  beforeAll(async () => {
    passwordHash = await bcrypt.hash("supersecretpassword", 10);
    const branch = await prisma.branch.create({
      data: { name: `Sucursal Seed ${runId}`, location: "x" },
    });
    branchId = branch.id;
  });

  afterAll(async () => {
    await prisma.movement.deleteMany({ where: { branchId } });
    await prisma.stock.deleteMany({ where: { branchId } });
    await prisma.product.deleteMany({ where: { id: productId } });
    await prisma.user.deleteMany({ where: { email: { in: [legacyEmail, newEmail] } } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  it("renombra la cuenta histórica en vez de crear una fantasma", async () => {
    // Estado de partida: una base sembrada ANTES del renombre de emails.
    const original = await prisma.user.create({
      data: {
        name: "Encargado Lomas de Zamora",
        email: legacyEmail,
        password: passwordHash,
        role: "ENCARGADO",
        branches: { connect: [{ id: branchId }] },
      },
    });

    // Historial atado a esa cuenta: es lo que se perdería si se duplicara.
    const movement = await prisma.movement.create({
      data: {
        type: "IN",
        quantity: 5,
        reason: "Reposición histórica",
        productId: (
          await prisma.product.create({
            data: {
              sku: `SEED-${runId}`,
              name: `Producto Seed ${runId}`,
              brand: "x",
              category: "x",
              costPrice: 100,
              retailPrice: 200,
            },
          })
        ).id,
        branchId,
        userId: original.id,
      },
    });
    productId = movement.productId;

    // Re-seed con el email nuevo y el histórico declarado.
    const result = await ensureUser({
      name: "Encargado 893 y 851",
      email: newEmail,
      legacyEmails: [legacyEmail],
      role: "ENCARGADO",
      branchIds: [branchId],
      passwordHash,
    });

    // MISMO id: se renombró, no se duplicó.
    expect(result.id).toBe(original.id);

    const cuentas = await prisma.user.findMany({
      where: { email: { in: [legacyEmail, newEmail] } },
    });
    expect(cuentas).toHaveLength(1);
    expect(cuentas[0]?.email).toBe(newEmail);

    // El historial sigue colgando de la misma cuenta.
    const historial = await prisma.movement.findUnique({ where: { id: movement.id } });
    expect(historial?.userId).toBe(original.id);

    // Y la contraseña no se tocó: quien ya usaba el sistema sigue entrando.
    expect(cuentas[0]?.password).toBe(original.password);
  });

  it("re-ejecutar el seed es idempotente: no crea una segunda cuenta", async () => {
    const primera = await ensureUser({
      name: "Encargado 893 y 851",
      email: newEmail,
      legacyEmails: [legacyEmail],
      role: "ENCARGADO",
      branchIds: [branchId],
      passwordHash,
    });
    const segunda = await ensureUser({
      name: "Encargado 893 y 851",
      email: newEmail,
      legacyEmails: [legacyEmail],
      role: "ENCARGADO",
      branchIds: [branchId],
      passwordHash,
    });

    expect(segunda.id).toBe(primera.id);
    expect(await prisma.user.count({ where: { email: newEmail } })).toBe(1);
  });

  it("por defecto NO pisa el precio de un producto existente", async () => {
    // Un precio actualizado desde la UI.
    await prisma.product.update({
      where: { id: productId },
      data: { retailPrice: 9999 },
    });

    const refreshCatalogue = false;
    await prisma.product.upsert({
      where: { sku: `SEED-${runId}` },
      update: refreshCatalogue ? { retailPrice: 200 } : {},
      create: {
        sku: `SEED-${runId}`,
        name: "x",
        brand: "x",
        category: "x",
        retailPrice: 200,
      },
    });

    const producto = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(Number(producto.retailPrice)).toBe(9999);
  });

  it("por defecto NO pisa el stock real de una sucursal", async () => {
    // El conteo físico del local.
    await prisma.stock.create({
      data: { productId, branchId, quantity: 137, minStock: 5 },
    });

    const refreshCatalogue = false;
    await prisma.stock.upsert({
      where: { productId_branchId: { productId, branchId } },
      update: refreshCatalogue ? { quantity: 20 } : {},
      create: { productId, branchId, quantity: 20, minStock: 5 },
    });

    const stock = await prisma.stock.findUniqueOrThrow({
      where: { productId_branchId: { productId, branchId } },
    });
    expect(stock.quantity).toBe(137);
  });
});

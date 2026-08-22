/**
 * Catálogo de prueba para MEDIR el POS, no para mirarlo.
 *
 *   npx ts-node scripts/demo-perf-pos.ts 128      · la escala real de hoy
 *   npx ts-node scripts/demo-perf-pos.ts 19325    · la escala que se quiere alcanzar
 *   npx ts-node scripts/demo-perf-pos.ts --limpiar
 *
 * Deja una sucursal con caja abierta, un usuario con contraseña conocida y N
 * productos con stock. Los nombres se arman con marcas y tipos reales del rubro
 * para que la búsqueda tenga que descartar coincidencias parciales, como pasa
 * en el mostrador: buscar "latex" tiene que competir contra cientos de látex.
 *
 * Se niega a correr si `DATABASE_URL` no termina en `_test`.
 */
import bcrypt from "bcrypt";

import prisma from "../src/config/db";
import { generateDeviceSecret, sha256 } from "../src/utils/terminalDevice.utils";

const MARCA = "PERF-POS";
const SUCURSAL = "Perf POS (demo)";
const CORREO = "perfpos";

const url = process.env.DATABASE_URL ?? "";
if (!/_test/u.test(url)) {
  console.error("\n  ⛔ DATABASE_URL no apunta a una base _test. Abortado.\n");
  process.exit(1);
}

const MARCAS = ["Alba", "Sinteplast", "Colorín", "Tersuave", "Sherwin Williams", "Plavicon", "Petrilac"];
const TIPOS = ["Látex Interior", "Látex Exterior", "Esmalte Sintético", "Barniz Marino", "Fijador", "Enduido", "Impermeabilizante"];
const ACABADOS = ["Mate", "Satinado", "Brillante"];
const MEDIDAS = ["1L", "4L", "10L", "20L"];
const COLORES = ["Blanco", "Negro", "Gris Perla", "Beige", "Ocre", "Verde Inglés", "Azul Marino"];

const limpiar = async () => {
  const gente = await prisma.user.findMany({
    where: { email: { contains: CORREO } },
    select: { id: true },
  });
  const ids = gente.map((p) => p.id);
  const sucursales = await prisma.branch.findMany({
    where: { name: SUCURSAL },
    select: { id: true },
  });
  const branchIds = sucursales.map((s) => s.id);

  await prisma.stock.deleteMany({ where: { product: { sku: { startsWith: MARCA } } } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: MARCA } } });
  await prisma.cashRegister.deleteMany({ where: { branchId: { in: branchIds } } });
  await prisma.terminal.deleteMany({ where: { code: { startsWith: MARCA } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
};

(async () => {
  const arg = process.argv[2] ?? "128";

  await limpiar();

  if (arg === "--limpiar") {
    console.log("Limpio.");
    await prisma.$disconnect();
    return;
  }

  const cuantos = Number(arg);
  if (!Number.isInteger(cuantos) || cuantos <= 0) {
    console.error("Pasá un número de productos, o --limpiar.");
    process.exit(1);
  }

  const sucursal = await prisma.branch.create({
    data: { name: SUCURSAL, location: "Medición" },
  });

  const usuario = await prisma.user.create({
    data: {
      name: "Medidor POS",
      email: `medidor@${CORREO}.test`,
      password: await bcrypt.hash("medir12345", 10),
      role: "ADMIN",
      branches: { connect: [{ id: sucursal.id }] },
    },
  });

  // La caja necesita su terminal: un turno sin terminal es un arqueo sin cajón.
  const terminal = await prisma.terminal.create({
    data: {
      code: `${MARCA}-01`,
      name: "Caja de medición",
      branchId: sucursal.id,
      deviceSecretHash: sha256(generateDeviceSecret()),
      deviceSecretVersion: 1,
    },
  });

  await prisma.cashRegister.create({
    data: {
      branchId: sucursal.id,
      userId: usuario.id,
      terminalId: terminal.id,
      initialBalance: 50_000,
      status: "OPEN",
    },
  });

  // Se insertan en lotes: 19.325 filas de a una tardarían más que la medición.
  const LOTE = 500;
  for (let desde = 0; desde < cuantos; desde += LOTE) {
    const hasta = Math.min(desde + LOTE, cuantos);
    const productos: Parameters<typeof prisma.product.createMany>[0]["data"] = [];

    for (let i = desde; i < hasta; i++) {
      const marca = MARCAS[i % MARCAS.length]!;
      const tipo = TIPOS[Math.floor(i / MARCAS.length) % TIPOS.length]!;
      const acabado = ACABADOS[i % ACABADOS.length]!;
      const color = COLORES[Math.floor(i / 3) % COLORES.length]!;
      const medida = MEDIDAS[i % MEDIDAS.length]!;

      productos.push({
        sku: `${MARCA}-${String(i).padStart(6, "0")}`,
        barcode: `779${String(i).padStart(10, "0")}`,
        name: `${tipo} ${acabado} ${color} ${medida}`,
        brand: marca,
        category: tipo,
        retailPrice: 8_000 + (i % 40) * 750,
        costPrice: 5_000 + (i % 40) * 500,
        isActive: true,
      });
    }

    await prisma.product.createMany({ data: productos, skipDuplicates: true });
  }

  const creados = await prisma.product.findMany({
    where: { sku: { startsWith: MARCA } },
    select: { id: true },
  });

  for (let desde = 0; desde < creados.length; desde += LOTE) {
    const lote = creados.slice(desde, desde + LOTE);
    await prisma.stock.createMany({
      data: lote.map((p) => ({
        productId: p.id,
        branchId: sucursal.id,
        quantity: 40,
        minStock: 5,
        criticalStock: 2,
      })),
      skipDuplicates: true,
    });
  }

  console.log(
    [
      "",
      `  ${creados.length} productos con stock en "${SUCURSAL}".`,
      "  Caja abierta.",
      "",
      `  Entrar con:  medidor@${CORREO}.test  /  medir12345`,
      "",
      "  Al terminar:  npx ts-node scripts/demo-perf-pos.ts --limpiar",
      "",
    ].join("\n"),
  );

  await prisma.$disconnect();
})();

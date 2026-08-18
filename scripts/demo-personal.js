/**
 * Escenario del libro del personal, en la base de TESTS.
 *
 * Arma una cuenta con la variedad que la pantalla tiene que saber contar:
 *
 *   · varios consumos, CON SUS ÍTEMS (producto, cantidad, precio)
 *     → es lo que permite discutir un cargo: sin los ítems, "se llevó $12.000"
 *   · un pago en efectivo y otro por transferencia
 *   · un ajuste a favor de la persona, con su motivo
 *   · movimientos repartidos en varios meses → para probar los filtros
 *
 * Guard: aborta si la base no termina en "_test".
 */
const { PrismaClient } = require("@prisma/client");
const { Pool } = require("pg");
const { PrismaPg } = require("@prisma/adapter-pg");

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  console.error("Falta TEST_DATABASE_URL.");
  process.exit(1);
}
const nombre = decodeURIComponent(new URL(url).pathname.replace(/^\//u, ""));
if (!nombre.endsWith("_test")) {
  console.error(`Abortado: la base "${nombre}" no termina en _test.`);
  process.exit(1);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: url })),
});

const hace = (dias, hora = 11) => {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  d.setHours(hora, 30, 0, 0);
  return d;
};

/** Borra todo lo que este script crea, en orden de dependencia. */
const limpiar = async () => {
  const empleado = await prisma.user.findFirst({
    where: { email: { startsWith: "demo_personal_" } },
  });
  if (!empleado) {
    console.log("No hay nada que limpiar.");
    return;
  }
  const cuenta = await prisma.staffAccount.findUnique({
    where: { userId: empleado.id },
  });
  if (cuenta) {
    await prisma.staffLedgerEntry.deleteMany({ where: { staffAccountId: cuenta.id } });
    await prisma.staffPaymentSettlement.deleteMany({ where: { staffAccountId: cuenta.id } });
    const consumos = await prisma.internalConsumption.findMany({
      where: { staffAccountId: cuenta.id },
      select: { id: true },
    });
    await prisma.internalConsumptionItem.deleteMany({
      where: { consumptionId: { in: consumos.map((c) => c.id) } },
    });
    await prisma.internalConsumption.deleteMany({ where: { staffAccountId: cuenta.id } });
    await prisma.staffAccount.delete({ where: { id: cuenta.id } });
  }
  await prisma.user.delete({ where: { id: empleado.id } });
  console.log(`Limpiado: ${empleado.name} y todo su libro.`);
};

const main = async () => {
  if (process.argv.includes("--limpiar")) return limpiar();

  const sucursal = await prisma.branch.findFirst({ where: { isActive: true } });
  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  const productos = await prisma.product.findMany({
    take: 4,
    where: { isActive: true },
    select: { id: true, name: true, retailPrice: true },
  });

  if (!sucursal || !admin || productos.length < 3) {
    console.error("Falta sucursal activa, un ADMIN o productos en la base de tests.");
    process.exit(1);
  }

  // El empleado dueño de la cuenta.
  const email = `demo_personal_${sucursal.id}@x.com`;
  const empleado =
    (await prisma.user.findUnique({ where: { email } })) ??
    (await prisma.user.create({
      data: {
        name: "Martín Rearte",
        email,
        // Hash inválido a propósito: esta cuenta es para mirar la pantalla, no
        // para iniciar sesión con ella.
        password: "no-se-usa",
        role: "EMPLOYEE",
        branches: { connect: [{ id: sucursal.id }] },
      },
    }));

  const cuenta =
    (await prisma.staffAccount.findUnique({ where: { userId: empleado.id } })) ??
    (await prisma.staffAccount.create({
      data: { userId: empleado.id, creditLimit: 150000 },
    }));

  const precio = (p) => Number(p.retailPrice ?? 10000);

  /** Un consumo con sus ítems, y su asiento en el libro. */
  const consumir = async (dias, lineas, motivo) => {
    const total = lineas.reduce(
      (s, [p, cant]) => s + precio(p) * cant,
      0,
    );
    const consumo = await prisma.internalConsumption.create({
      data: {
        kind: "EMPLOYEE_PERSONAL",
        branchId: sucursal.id,
        staffAccountId: cuenta.id,
        pricePolicy: "STAFF_DISCOUNT",
        pricePolicyRate: 0.15,
        totalAmount: total,
        totalCost: 0,
        createdById: admin.id,
        createdAt: hace(dias),
        items: {
          create: lineas.map(([p, cant]) => ({
            productId: p.id,
            quantity: cant,
            listPrice: precio(p),
            unitPrice: precio(p),
            subtotal: precio(p) * cant,
          })),
        },
      },
    });

    await prisma.staffLedgerEntry.create({
      data: {
        staffAccountId: cuenta.id,
        type: "CONSUMPTION",
        debit: total,
        credit: 0,
        reason: motivo,
        sourceType: "InternalConsumption",
        sourceId: consumo.id,
        createdById: admin.id,
        createdAt: hace(dias),
      },
    });
    return total;
  };

  const [p1, p2, p3, p4] = productos;

  let debe = 0;
  debe += await consumir(75, [[p1, 2], [p2, 1]], "Pintura para la casa");
  debe += await consumir(48, [[p3, 3]], "Rodillos y bandeja");
  debe += await consumir(20, [[p2, 1], [p4 ?? p1, 2]], "Terminación del comedor");
  debe += await consumir(5, [[p1, 1]], "Un litro de látex");

  // Un pago en efectivo, con su liquidación.
  const liquidacion = await prisma.staffPaymentSettlement.create({
    data: {
      staffAccountId: cuenta.id,
      method: "CASH",
      amount: 40000,
      branchId: sucursal.id,
      createdById: admin.id,
      createdAt: hace(30),
    },
  });
  await prisma.staffLedgerEntry.create({
    data: {
      staffAccountId: cuenta.id,
      type: "PAYMENT",
      debit: 0,
      credit: 40000,
      reason: "Pagó en efectivo",
      sourceType: "StaffPaymentSettlement",
      sourceId: liquidacion.id,
      createdById: admin.id,
      createdAt: hace(30),
    },
  });

  // Y un ajuste a favor: lo que la pantalla no permitía hacer hasta ahora.
  await prisma.staffLedgerEntry.create({
    data: {
      staffAccountId: cuenta.id,
      type: "ADJUSTMENT_CREDIT",
      debit: 0,
      credit: 12000,
      reason: "Se le reconoce el sábado que vino a cerrar",
      createdById: admin.id,
      authorizedById: admin.id,
      createdAt: hace(12),
    },
  });

  const saldo = debe - 40000 - 12000;
  console.log(`Sucursal: ${sucursal.name} · cuenta #${cuenta.id} de ${empleado.name}`);
  console.log(`4 consumos con ítems, 1 pago en efectivo, 1 ajuste a favor.`);
  console.log(`Saldo esperado: $${saldo.toLocaleString("es-AR")}`);
};

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

/**
 * Limpieza: `node scripts/demo-personal.js --limpiar`
 *
 * Existe porque este escenario deja un EMPLOYEE con movimientos en el libro, y
 * eso bloquea el borrado masivo de roles que ejercita `admin-roles-branches`.
 * Un escenario de demo que rompe la suite no es un escenario de demo.
 */

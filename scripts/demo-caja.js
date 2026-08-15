/**
 * Escenario de caja para revisar el módulo a fondo, en la base de TESTS.
 *
 * Arma un turno con todo lo que puede tocar el cajón, para poder ver si el
 * arqueo cierra:
 *
 *   apertura $50.000
 *   + cobros en efectivo
 *   + cobros que NO son efectivo (no deben mover el cajón)
 *   − gastos
 *   + un ingreso manual
 *   − un retiro manual
 *   + un cobro en efectivo de una cuenta del personal  ← el bug de "INCOME"
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

(async () => {
  const branch = await prisma.branch.findFirst({ where: { name: "Demo Incentivos" } });
  const duenio = await prisma.user.findUnique({
    where: { email: "demo.duenio@local.test" },
  });
  if (!branch || !duenio) {
    console.error("Falta el escenario base. Corré antes scripts/demo-incentives.js");
    process.exit(1);
  }

  // Se cierra cualquier turno abierto para arrancar de cero, con su arqueo.
  await prisma.cashRegister.updateMany({
    where: { branchId: branch.id, status: "OPEN" },
    data: { status: "CLOSED", actualBalance: 0, closingTime: new Date() },
  });

  const terminal = await prisma.terminal.findFirst({ where: { branchId: branch.id } });

  const caja = await prisma.cashRegister.create({
    data: {
      branchId: branch.id,
      terminalId: terminal.id,
      userId: duenio.id,
      initialBalance: 50000,
      status: "OPEN",
    },
  });

  const cliente = await prisma.customer.findFirst({ where: { name: "Cliente Demo" } });
  const producto = await prisma.product.findFirst({ where: { sku: "DEMO-INC-1" } });

  /** Venta con su pago, para que el cobro entre al turno. */
  const venta = async (total, metodo) => {
    const v = await prisma.sale.create({
      data: {
        totalAmount: total,
        paymentMethod: metodo,
        status: "PAID",
        balance: 0,
        customerId: cliente.id,
        branchId: branch.id,
        userId: duenio.id,
        sellerId: duenio.id,
        cashierId: duenio.id,
        cashRegisterId: caja.id,
        kind: "SALE",
      },
    });
    await prisma.saleItem.create({
      data: {
        saleId: v.id,
        productId: producto.id,
        quantity: 1,
        unitPrice: total,
        subtotal: total,
        unitCost: total / 2,
      },
    });
    await prisma.payment.create({
      data: {
        sale: { connect: { id: v.id } },
        user: { connect: { id: duenio.id } },
        cashRegister: { connect: { id: caja.id } },
        branch: { connect: { id: branch.id } },
        amount: total,
        paymentMethod: metodo,
      },
    });
    return v;
  };

  await venta(18000, "CASH");
  await venta(7500, "CASH");
  await venta(42000, "DEBIT"); // no toca el cajón
  await venta(31000, "TRANSFER"); // tampoco

  await prisma.expense.create({
    data: {
      amount: 6200,
      reason: "Flete de la mañana",
      category: "LOGISTICA",
      cashRegisterId: caja.id,
      userId: duenio.id,
      branchId: branch.id,
    },
  });

  await prisma.cashMovement.create({
    data: {
      type: "IN",
      amount: 10000,
      reason: "Refuerzo de cambio",
      cashRegisterId: caja.id,
      userId: duenio.id,
      branchId: branch.id,
    },
  });
  await prisma.cashMovement.create({
    data: {
      type: "OUT",
      amount: 4000,
      reason: "Retiro a bóveda",
      cashRegisterId: caja.id,
      userId: duenio.id,
      branchId: branch.id,
    },
  });

  // El movimiento con el tipo VIEJO, a propósito: así se puede comprobar que
  // ahora la pantalla lo denuncia en vez de tragárselo.
  await prisma.cashMovement.create({
    data: {
      type: "INCOME",
      amount: 3300,
      reason: "Cobro a un empleado (tipo viejo, a propósito)",
      cashRegisterId: caja.id,
      userId: duenio.id,
      branchId: branch.id,
    },
  });

  const esperado = 50000 + 18000 + 7500 - 6200 + 10000 - 4000;

  console.log(`\n✔ Turno #${caja.id} abierto en "${branch.name}" (base ${nombre}).`);
  console.log(`  Apertura ................. $50.000`);
  console.log(`  + Cobros en efectivo ..... $25.500  (18.000 + 7.500)`);
  console.log(`  + No efectivo ............ $73.000  (débito y transferencia, NO tocan el cajón)`);
  console.log(`  − Gastos ................. $6.200`);
  console.log(`  + Ingreso manual ......... $10.000`);
  console.log(`  − Retiro manual .......... $4.000`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  ESPERADO EN EL CAJÓN ..... $${esperado.toLocaleString("es-AR")}`);
  console.log(`\n  ⚠ Además hay un movimiento de $3.300 con el tipo viejo "INCOME":`);
  console.log(`    la pantalla de cierre TIENE que denunciarlo, no tragárselo.\n`);

  await prisma.$disconnect();
})().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});

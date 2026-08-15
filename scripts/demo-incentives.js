/**
 * Datos de demostración para verificar Incentivos en el navegador.
 *
 * Crea un dueño, dos vendedores con legajo, un plan al 3% con política MIXED y
 * un puñado de ventas —algunas cobradas, otras fiadas— para que la pantalla
 * tenga algo real que mostrar.
 *
 * Guard: aborta si la base no termina en "_test". NUNCA corre contra producción.
 */
const bcrypt = require("bcrypt");
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
process.env.DATABASE_URL = url;

const prisma = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: url })),
});

const CLAVE = "Demo1234!";

(async () => {
  const branch =
    (await prisma.branch.findFirst({ where: { name: "Demo Incentivos" } })) ??
    (await prisma.branch.create({
      data: { name: "Demo Incentivos", location: "Local", isActive: true },
    }));

  const hash = await bcrypt.hash(CLAVE, 10);

  const upsertUser = async (email, name, role) => {
    const existente = await prisma.user.findUnique({ where: { email } });
    if (existente) {
      return prisma.user.update({
        where: { id: existente.id },
        data: { password: hash, branches: { connect: [{ id: branch.id }] } },
      });
    }
    return prisma.user.create({
      data: {
        email,
        name,
        password: hash,
        role,
        branches: { connect: [{ id: branch.id }] },
      },
    });
  };

  const duenio = await upsertUser("demo.duenio@local.test", "Agustín (dueño)", "ADMIN");
  const ana = await upsertUser("demo.ana@local.test", "Ana Vendedora", "EMPLOYEE");
  const beto = await upsertUser("demo.beto@local.test", "Beto Vendedor", "EMPLOYEE");

  for (const u of [ana, beto]) {
    const yaTiene = await prisma.employee.findUnique({ where: { userId: u.id } });
    if (!yaTiene) {
      await prisma.employee.create({
        data: {
          userId: u.id,
          position: "Vendedor",
          salaryType: "COMMISSION",
          baseSalary: 800000,
          branchId: branch.id,
        },
      });
    }
  }

  const producto =
    (await prisma.product.findFirst({ where: { sku: "DEMO-INC-1" } })) ??
    (await prisma.product.create({
      data: {
        sku: "DEMO-INC-1",
        name: "Látex interior 20L",
        brand: "Demo",
        category: "Pinturas",
        retailPrice: 85000,
        costPrice: 51000,
      },
    }));

  // Un producto SIN costo, para que se vea la advertencia de "sin costo".
  const sinCosto =
    (await prisma.product.findFirst({ where: { sku: "DEMO-INC-2" } })) ??
    (await prisma.product.create({
      data: {
        sku: "DEMO-INC-2",
        name: "Rodillo importado",
        brand: "Demo",
        category: "Accesorios",
        retailPrice: 32000,
        costPrice: 0,
      },
    }));

  const cliente =
    (await prisma.customer.findFirst({ where: { name: "Cliente Demo" } })) ??
    (await prisma.customer.create({ data: { name: "Cliente Demo", type: "REGULAR" } }));

  let terminal = await prisma.terminal.findFirst({ where: { branchId: branch.id } });
  if (!terminal) {
    terminal = await prisma.terminal.create({
      data: { branchId: branch.id, code: `DEMO-INC-${branch.id}`, name: "Caja demo" },
    });
  }

  let caja = await prisma.cashRegister.findFirst({
    where: { branchId: branch.id, status: "OPEN" },
  });
  if (!caja) {
    caja = await prisma.cashRegister.create({
      data: {
        branchId: branch.id,
        terminalId: terminal.id,
        userId: duenio.id,
        initialBalance: 0,
        status: "OPEN",
      },
    });
  }

  // Se rehacen las ventas de demo en cada corrida para que el resultado sea
  // predecible: si no, cada ejecución acumularía y los números no cerrarían.
  const viejas = await prisma.sale.findMany({
    where: { branchId: branch.id },
    select: { id: true },
  });
  const ids = viejas.map((v) => v.id);
  if (ids.length > 0) {
    await prisma.incentiveLedgerEntry.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.saleItem.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.payment.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.sale.deleteMany({ where: { id: { in: ids } } });
  }

  const venta = async (sellerId, total, balance, productId, unitCost) => {
    const s = await prisma.sale.create({
      data: {
        totalAmount: total,
        paymentMethod: balance > 0 ? "CREDIT_ACCOUNT" : "CASH",
        status: balance > 0 ? (balance === total ? "PENDING" : "PARTIAL") : "PAID",
        balance,
        customerId: cliente.id,
        branchId: branch.id,
        userId: sellerId,
        sellerId,
        cashierId: sellerId,
        cashRegisterId: caja.id,
        kind: "SALE",
      },
    });
    await prisma.saleItem.create({
      data: {
        saleId: s.id,
        productId,
        quantity: 1,
        unitPrice: total,
        subtotal: total,
        unitCost,
      },
    });
  };

  // Los planes de la base de tests son sintéticos y se rehacen: si sobrevive
  // uno de una corrida anterior, el cálculo lo elige a él y la demo miente.
  await prisma.incentiveSettlement.deleteMany({});
  await prisma.incentiveLedgerEntry.deleteMany({});
  await prisma.salesTarget.deleteMany({});
  await prisma.incentivePeriod.deleteMany({});
  await prisma.incentiveRule.deleteMany({});
  await prisma.incentivePlan.deleteMany({});

  await prisma.incentivePlan.create({
    data: {
      name: "Comisiones 2026",
      cadence: "MONTHLY",
      eligibilityPolicy: "MIXED",
      effectiveFrom: new Date(Date.now() - 365 * 86_400_000),
      createdById: duenio.id,
      rules: {
        create: [
          { kind: "PERCENT_OF_SALES", percent: 3, effectiveFrom: new Date() },
        ],
      },
    },
  });

  // Ana: fuerte en contado.
  await venta(ana.id, 420000, 0, producto.id, 252000);
  await venta(ana.id, 180000, 0, producto.id, 108000);
  await venta(ana.id, 250000, 250000, producto.id, 150000); // fiado: queda en espera

  // Beto: vendió más, pero casi todo fiado. Es el contraste que hace visible
  // para qué sirve la política MIXED.
  await venta(beto.id, 600000, 600000, producto.id, 360000);
  await venta(beto.id, 150000, 0, producto.id, 90000);
  await venta(beto.id, 96000, 0, sinCosto.id, null); // sin costo cargado

  console.log(`✔ Sucursal "${branch.name}" lista en la base "${nombre}".`);
  console.log(`  Dueño:     demo.duenio@local.test / ${CLAVE}`);
  console.log(`  Vendedora: demo.ana@local.test / ${CLAVE}`);
  console.log(`  6 ventas creadas (contado y fiado, una sin costo).`);

  await prisma.$disconnect();
})().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});

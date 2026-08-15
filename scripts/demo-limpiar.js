/**
 * Borra el escenario de demo de la base de TESTS.
 *
 * Los scripts `demo-*.js` sirven para revisar módulos en el navegador, pero
 * viven en la MISMA base que la suite de tests. Y el cálculo de incentivos mira
 * las ventas de toda la empresa —correcto para el negocio—, así que esas ventas
 * de demo se cuelan en los períodos que arman los tests y les rompen las
 * aprobaciones.
 *
 * Correr esto al terminar de revisar en el navegador deja la suite limpia.
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
  // Todo lo de incentivos se va: los tests arman el suyo desde cero.
  await prisma.incentiveSettlement.deleteMany({});
  await prisma.incentiveLedgerEntry.deleteMany({});
  await prisma.salesTarget.deleteMany({});
  await prisma.incentivePeriod.deleteMany({});
  await prisma.incentiveRule.deleteMany({});
  await prisma.incentivePlan.deleteMany({});

  const branch = await prisma.branch.findFirst({
    where: { name: "Demo Incentivos" },
  });
  if (!branch) {
    console.log(`Sin sucursal de demo en "${nombre}". Incentivos limpiados igual.`);
    await prisma.$disconnect();
    return;
  }

  const ventas = await prisma.sale.findMany({
    where: { branchId: branch.id },
    select: { id: true },
  });
  const ids = ventas.map((v) => v.id);
  if (ids.length > 0) {
    await prisma.saleItem.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.payment.deleteMany({ where: { saleId: { in: ids } } });
    await prisma.sale.deleteMany({ where: { id: { in: ids } } });
  }

  const legajos = await prisma.employee.findMany({
    where: { branchId: branch.id },
    select: { id: true },
  });
  await prisma.payrollRecord.deleteMany({
    where: { employeeId: { in: legajos.map((e) => e.id) } },
  });

  await prisma.cashMovement.deleteMany({ where: { branchId: branch.id } });
  await prisma.expense.deleteMany({ where: { branchId: branch.id } });

  console.log(
    `✔ Escenario de demo limpiado en "${nombre}": ${ids.length} ventas y su rastro.`,
  );
  await prisma.$disconnect();
})().catch(async (error) => {
  console.error(error.message);
  await prisma.$disconnect();
  process.exit(1);
});

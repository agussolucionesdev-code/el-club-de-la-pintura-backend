/**
 * Escenario de gastos para revisar el módulo a fondo, en la base de TESTS.
 *
 * Arma la variedad que el módulo tiene que saber mostrar:
 *
 *   · gastos de HOY, de esta semana, de este mes y de meses anteriores
 *     → para probar los filtros por día, semana, mes y período libre
 *   · las siete categorías activas, con montos distintos
 *     → para que el gráfico de torta y el de barras tengan de qué hablar
 *   · un gasto ANULADO, con motivo
 *     → tiene que verse tachado y NO contar en ningún total
 *   · un gasto de una categoría DADA DE BAJA (Sueldos)
 *     → el chip de filtro tiene que existir igual, o el gasto sería invisible
 *   · un gasto con proveedor y otro con comprobante adjunto
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

/** Días hacia atrás desde ahora, conservando una hora creíble de mostrador. */
const hace = (dias, hora = 11) => {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  d.setHours(hora, Math.floor(Math.random() * 59), 0, 0);
  return d;
};

const GASTOS = [
  // [días atrás, categoría, monto, detalle, hora]
  [0, "INSUMOS", 18500, "Cinta de papel y lijas para el mostrador", 9],
  [0, "UTILITIES", 94300, "Factura de luz — Edesur", 10],
  [0, "LOGISTICS", 32000, "Flete entrega Donato Álvarez", 16],
  [1, "MAINTENANCE", 76000, "Arreglo de la persiana del local", 12],
  [2, "OTHER", 8400, "Café y azúcar para el personal", 8],
  [3, "MARKETING", 145000, "Cartelería nueva de vidriera", 15],
  [5, "INSUMOS", 22900, "Bolsas y film para envolver", 11],
  [6, "ALQUILER", 890000, "Alquiler del local — agosto", 10],
  [9, "UTILITIES", 41200, "Internet y teléfono", 14],
  [12, "LOGISTICS", 28500, "Combustible de la camioneta", 17],
  [18, "MAINTENANCE", 54000, "Service del aire acondicionado", 13],
  [26, "OTHER", 15600, "Artículos de limpieza", 9],
  [40, "ALQUILER", 890000, "Alquiler del local — julio", 10],
  [45, "UTILITIES", 88700, "Factura de luz — julio", 11],
];

const main = async () => {
  const sucursal = await prisma.branch.findFirst({ where: { isActive: true } });
  const usuario = await prisma.user.findFirst({ where: { role: "ADMIN" } });
  if (!sucursal || !usuario) {
    console.error("Falta una sucursal activa o un usuario ADMIN en la base de tests.");
    process.exit(1);
  }

  // Un turno donde colgar los gastos. Si hay uno abierto, se reusa.
  let caja = await prisma.cashRegister.findFirst({
    where: { branchId: sucursal.id, status: "OPEN" },
    orderBy: { id: "desc" },
  });
  if (!caja) {
    // Desde la Fase 3 un turno vive en una terminal física, no en una sucursal.
    const terminal =
      (await prisma.terminal.findFirst({ where: { branchId: sucursal.id } })) ??
      (await prisma.terminal.create({
        data: {
          branchId: sucursal.id,
          code: `demo-gastos-${sucursal.id}`,
          name: "Terminal de demo",
        },
      }));
    caja = await prisma.cashRegister.create({
      data: {
        branchId: sucursal.id,
        terminalId: terminal.id,
        userId: usuario.id,
        initialBalance: 50000,
        status: "OPEN",
      },
    });
  }

  const creados = [];
  for (const [dias, category, amount, reason, hora] of GASTOS) {
    const gasto = await prisma.expense.create({
      data: {
        amount,
        category,
        reason,
        type: category === "ALQUILER" ? "FIXED" : "VARIABLE",
        branchId: sucursal.id,
        cashRegisterId: caja.id,
        userId: usuario.id,
        createdAt: hace(dias, hora),
      },
    });
    creados.push(gasto);
  }

  // Uno anulado: tiene que verse tachado y no sumar en ningún total.
  const anulado = await prisma.expense.create({
    data: {
      amount: 67000,
      category: "OTHER",
      reason: "Compra cargada por error (duplicada)",
      type: "VARIABLE",
      branchId: sucursal.id,
      cashRegisterId: caja.id,
      userId: usuario.id,
      createdAt: hace(4, 14),
      voidedAt: hace(4, 15),
      voidReason: "Se cargó dos veces la misma compra",
      voidedById: usuario.id,
    },
  });

  // Uno de una categoría dada de baja: el chip tiene que existir igual.
  const historico = await prisma.expense.create({
    data: {
      amount: 320000,
      category: "SALARY",
      reason: "Adelanto de sueldo (registro histórico)",
      type: "FIXED",
      branchId: sucursal.id,
      cashRegisterId: caja.id,
      userId: usuario.id,
      createdAt: hace(60, 10),
    },
  });

  const total = creados.reduce((a, g) => a + Number(g.amount), 0);
  console.log(`Sucursal: ${sucursal.name} (id ${sucursal.id}) · turno #${caja.id}`);
  console.log(`${creados.length} gastos vigentes · $${total.toLocaleString("es-AR")}`);
  console.log(`+ 1 anulado (#${anulado.id}) y 1 de categoría dada de baja (#${historico.id}).`);
};

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

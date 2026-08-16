/**
 * Verificación de SÓLO LECTURA del módulo de Gastos contra producción.
 *
 * Que el frontend haya deployado no prueba que la base acompañe: las categorías
 * viven en una tabla nueva y en tres migraciones, y este host tiene historial de
 * saltearse migraciones. Si `ExpenseCategory` no existe, la pantalla carga y
 * queda sin categorías — un fallo silencioso, que es el peor.
 *
 * Sólo ejecuta SELECT, y la sesión se abre en modo de sólo lectura para que el
 * motor rechace cualquier escritura, incluso por error.
 */
const { Client } = require("pg");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL.");
  process.exit(1);
}

const client = new Client({ connectionString: url });

const ESPERADAS = [
  "20260816064815_add_expense_categories",
  "20260816072000_expense_categories_completar",
  "20260816080000_gastos_sin_proveedores_ni_sueldos",
];

/** Las que el dueño tiene que poder elegir hoy. */
const ACTIVAS_ESPERADAS = [
  "ALQUILER",
  "UTILITIES",
  "INSUMOS",
  "LOGISTICS",
  "MAINTENANCE",
  "MARKETING",
  "OTHER",
];

/** Las que el usuario pidió sacar de Gastos. */
const INACTIVAS_ESPERADAS = ["SUPPLIER_PAYMENT", "SALARY"];

(async () => {
  await client.connect();
  await client.query("SET default_transaction_read_only = on");

  const base = (await client.query("SELECT current_database() AS db")).rows[0].db;
  console.log(`\nBase: ${base}\n`);

  let fallas = 0;

  // 1. Migraciones
  const { rows: migs } = await client.query(
    `SELECT migration_name FROM _prisma_migrations
      WHERE migration_name = ANY($1) AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL`,
    [ESPERADAS],
  );
  const aplicadas = new Set(migs.map((m) => m.migration_name));
  const faltan = ESPERADAS.filter((m) => !aplicadas.has(m));
  if (faltan.length) {
    console.log(`✘ FALTAN MIGRACIONES: ${faltan.join(", ")}`);
    fallas++;
  } else {
    console.log(`✔ Las ${ESPERADAS.length} migraciones de Gastos están aplicadas.`);
  }

  // 2. La tabla existe
  const { rowCount: hayTabla } = await client.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'ExpenseCategory'`,
  );
  if (!hayTabla) {
    console.log("✘ NO EXISTE la tabla ExpenseCategory. Nada más que verificar.");
    await client.end();
    process.exit(1);
  }
  console.log("✔ La tabla ExpenseCategory existe.");

  // 3. Las categorías, con su estado real
  const { rows: cats } = await client.query(
    `SELECT key, label, color, "isActive", "isSystem"
       FROM "ExpenseCategory" ORDER BY "sortOrder", id`,
  );

  console.log(`\nCategorías en producción (${cats.length}):`);
  for (const c of cats) {
    console.log(
      `  ${c.isActive ? "activa " : "de baja"} ${c.key.padEnd(18)} ${c.color}  ${c.label}`,
    );
  }

  const activas = new Set(cats.filter((c) => c.isActive).map((c) => c.key));
  const sinActivar = ACTIVAS_ESPERADAS.filter((k) => !activas.has(k));
  if (sinActivar.length) {
    console.log(`\n✘ Deberían estar ACTIVAS y no lo están: ${sinActivar.join(", ")}`);
    fallas++;
  } else {
    console.log(`\n✔ Las ${ACTIVAS_ESPERADAS.length} categorías elegibles están activas.`);
  }

  const vivasQueNoDeberian = INACTIVAS_ESPERADAS.filter((k) => activas.has(k));
  if (vivasQueNoDeberian.length) {
    console.log(`✘ SIGUEN ACTIVAS y no deberían: ${vivasQueNoDeberian.join(", ")}`);
    fallas++;
  } else {
    console.log("✔ Pagos a proveedores y sueldos están fuera de uso, sin borrarse.");
  }

  // 4. Ningún gasto quedó apuntando a una categoría que no existe: si pasara,
  //    la pantalla mostraría la clave cruda en vez de un nombre.
  const { rows: huerfanos } = await client.query(
    `SELECT e.category, COUNT(*)::int AS n
       FROM "Expense" e
       LEFT JOIN "ExpenseCategory" c ON c.key = e.category
      WHERE c.key IS NULL
      GROUP BY e.category`,
  );
  if (huerfanos.length) {
    console.log("\n✘ Gastos con una categoría que no existe en la tabla:");
    for (const h of huerfanos) console.log(`    ${h.category}: ${h.n} gasto(s)`);
    fallas++;
  } else {
    console.log("✔ Todos los gastos apuntan a una categoría existente.");
  }

  // 5. Cuántos gastos hay realmente, para saber si esto ya se está usando.
  const { rows: uso } = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE "voidedAt" IS NOT NULL)::int AS anulados,
            COUNT(*) FILTER (WHERE type = 'FIXED')::int AS fijos
       FROM "Expense"`,
  );
  const u = uso[0];
  console.log(
    `\nUso real: ${u.total} gastos (${u.anulados} anulados, ${u.fijos} fijos).`,
  );

  console.log(fallas === 0 ? "\n✔ TODO EN ORDEN.\n" : `\n✘ ${fallas} problema(s).\n`);
  await client.end();
  process.exit(fallas === 0 ? 0 : 1);
})().catch(async (e) => {
  console.error(e.message);
  try {
    await client.end();
  } catch {
    /* ya cerrada */
  }
  process.exit(1);
});

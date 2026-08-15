/**
 * Verificación de SÓLO LECTURA contra producción.
 *
 * Existe porque el 401 de un endpoint nuevo prueba que la ruta está registrada,
 * pero NO que su tabla exista: la autenticación se resuelve en el middleware,
 * antes de tocar la base. Y este host tiene historial de saltearse las
 * migraciones, así que "deployó" y "el esquema está" son dos cosas distintas.
 *
 * Sólo ejecuta SELECT. No hay una sola sentencia de escritura en este archivo,
 * y la conexión se abre en modo de sólo lectura para que la base rechace
 * cualquier intento, incluso por error.
 */
const { Client } = require("pg");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL.");
  process.exit(1);
}

const client = new Client({ connectionString: url });

/** Migraciones que tienen que estar aplicadas para que las Fases 8 y 9 anden. */
const ESPERADAS = [
  "20260815004314_add_incentive_engine",
  "20260815040740_add_offline_lease",
  "20260815060824_add_attribution_confirmation",
];

/** Tablas y columnas que esas migraciones tenían que crear. */
const TABLAS = [
  "IncentivePlan",
  "IncentiveRule",
  "IncentivePeriod",
  "IncentiveLedgerEntry",
  "IncentiveSettlement",
  "SalesTarget",
];

const COLUMNAS = [
  ["SyncOperation", "leaseToken"],
  ["SyncOperation", "sequence"],
  ["SyncOperation", "attributionUnverified"],
  ["SyncOperation", "attributionConfirmedAt"],
  ["Terminal", "lastOfflineSequence"],
];

(async () => {
  await client.connect();
  // La sesión entera queda de sólo lectura: un INSERT acá falla en el motor.
  await client.query("SET default_transaction_read_only = on");

  const nombre = (await client.query("SELECT current_database() AS db")).rows[0].db;
  console.log(`\nBase: ${nombre}\n`);

  const { rows: migraciones } = await client.query(
    `SELECT migration_name, finished_at, rolled_back_at
       FROM _prisma_migrations
      ORDER BY started_at DESC
      LIMIT 8`,
  );

  console.log("Últimas migraciones:");
  for (const m of migraciones) {
    const estado = m.rolled_back_at
      ? "REVERTIDA"
      : m.finished_at
        ? "aplicada"
        : "SIN TERMINAR";
    console.log(`  [${estado}] ${m.migration_name}`);
  }

  const aplicadas = new Set(
    migraciones.filter((m) => m.finished_at && !m.rolled_back_at).map((m) => m.migration_name),
  );
  const faltantes = ESPERADAS.filter((e) => !aplicadas.has(e));
  console.log(
    faltantes.length === 0
      ? "\n✔ Las 3 migraciones de las Fases 8 y 9 están aplicadas."
      : `\n✘ FALTAN: ${faltantes.join(", ")}`,
  );

  const { rows: tablas } = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLAS],
  );
  const presentes = new Set(tablas.map((t) => t.table_name));
  const sinTabla = TABLAS.filter((t) => !presentes.has(t));
  console.log(
    sinTabla.length === 0
      ? `✔ Las ${TABLAS.length} tablas de incentivos existen.`
      : `✘ FALTAN TABLAS: ${sinTabla.join(", ")}`,
  );

  const sinColumna = [];
  for (const [tabla, columna] of COLUMNAS) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [tabla, columna],
    );
    if (!rowCount) sinColumna.push(`${tabla}.${columna}`);
  }
  console.log(
    sinColumna.length === 0
      ? `✔ Las ${COLUMNAS.length} columnas del permiso offline existen.`
      : `✘ FALTAN COLUMNAS: ${sinColumna.join(", ")}`,
  );

  // Índices parciales: Prisma no los expresa, así que se crearon con SQL cruda
  // y son justo los que se pierden si alguien edita una migración a mano.
  const { rows: indices } = await client.query(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('legacy_transfer_one_live_cycle_per_sale',
                          'legacy_link_one_confirmed_per_customer')`,
  );
  console.log(
    indices.length === 2
      ? "✔ Los índices parciales del traslado legado siguen vivos."
      : `✘ Índices parciales presentes: ${indices.length}/2`,
  );

  const problemas =
    faltantes.length + sinTabla.length + sinColumna.length + (2 - indices.length);
  console.log(
    problemas === 0
      ? "\n✅ Producción coherente con el código desplegado.\n"
      : `\n⚠️  ${problemas} problema(s) detectado(s).\n`,
  );

  await client.end();
})().catch(async (error) => {
  console.error("Fallo la verificación:", error.message);
  await client.end().catch(() => {});
  process.exit(1);
});

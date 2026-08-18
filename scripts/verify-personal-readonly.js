/**
 * Verificación de SÓLO LECTURA del libro del personal contra producción.
 *
 * El módulo no trajo migraciones, así que acá no se comprueba el esquema: se
 * comprueba que los DATOS soporten lo que la pantalla nueva promete.
 *
 * En concreto, el "qué se llevó" del extracto se resuelve siguiendo
 * `sourceType` + `sourceId` hasta el consumo y sus ítems. Si los asientos
 * reales no tienen ese vínculo —porque se crearon por otra vía, o porque el
 * consumo se borró— la ficha va a quedar vacía y la promesa no se cumple. Eso
 * no lo detecta ningún test: depende de los datos que hay.
 *
 * Sólo ejecuta SELECT, con la sesión en modo de sólo lectura para que el motor
 * rechace cualquier escritura, incluso por error.
 */
const { Client } = require("pg");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Falta DATABASE_URL.");
  process.exit(1);
}

const client = new Client({ connectionString: url });

(async () => {
  await client.connect();
  await client.query("SET default_transaction_read_only = on");

  const base = (await client.query("SELECT current_database() AS db")).rows[0].db;
  console.log(`\nBase: ${base}\n`);

  let avisos = 0;

  // 1. ¿Cuánto se usa el módulo?
  const { rows: uso } = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM "StaffAccount")               AS cuentas,
       (SELECT COUNT(*)::int FROM "StaffLedgerEntry")           AS asientos,
       (SELECT COUNT(*)::int FROM "InternalConsumption")        AS consumos,
       (SELECT COUNT(*)::int FROM "StaffPaymentSettlement")     AS pagos`,
  );
  const u = uso[0];
  console.log(
    `Uso real: ${u.cuentas} cuenta(s), ${u.asientos} movimientos, ` +
      `${u.consumos} consumos, ${u.pagos} pagos registrados.`,
  );

  if (u.asientos === 0) {
    console.log(
      "\nEl libro está vacío: no hay nada que verificar todavía. La pantalla" +
        "\nva a mostrar el estado inicial, que es lo correcto.\n",
    );
    await client.end();
    return;
  }

  // 2. Saldo por cuenta, calculado como lo calcula la app.
  const { rows: saldos } = await client.query(
    `SELECT u.name,
            SUM(e.debit - e.credit)::float AS saldo,
            COUNT(*)::int                  AS movimientos
       FROM "StaffLedgerEntry" e
       JOIN "StaffAccount" a ON a.id = e."staffAccountId"
       JOIN "User" u         ON u.id = a."userId"
      GROUP BY u.name
      ORDER BY saldo DESC`,
  );
  console.log("\nSaldos:");
  for (const s of saldos) {
    console.log(
      `  ${String(s.name).padEnd(24)} $${Number(s.saldo).toLocaleString("es-AR").padStart(12)}` +
        `  (${s.movimientos} mov.)`,
    );
  }

  // 3. El vínculo que alimenta el "qué se llevó".
  const { rows: consumos } = await client.query(
    `SELECT COUNT(*)::int                                                   AS total,
            COUNT(*) FILTER (WHERE "sourceType" = 'InternalConsumption'
                               AND "sourceId" IS NOT NULL)::int             AS con_vinculo
       FROM "StaffLedgerEntry"
      WHERE type = 'CONSUMPTION'`,
  );
  const c = consumos[0];
  if (c.total === 0) {
    console.log("\n· Todavía no hay cargos por consumo.");
  } else if (c.con_vinculo < c.total) {
    console.log(
      `\n⚠ ${c.total - c.con_vinculo} de ${c.total} cargos por consumo NO tienen` +
        `\n  vínculo con su consumo: en esos, la ficha no va a poder mostrar qué` +
        `\n  se llevó. Se ven igual, con su monto y su motivo.`,
    );
    avisos++;
  } else {
    console.log(
      `\n✔ Los ${c.total} cargos por consumo tienen su vínculo: la ficha puede` +
        `\n  mostrar qué se llevó en todos.`,
    );
  }

  // 4. ¿Los consumos vinculados tienen ítems de verdad?
  const { rows: huerfanos } = await client.query(
    `SELECT COUNT(*)::int AS n
       FROM "StaffLedgerEntry" e
       JOIN "InternalConsumption" ic ON ic.id = e."sourceId"
      WHERE e.type = 'CONSUMPTION'
        AND e."sourceType" = 'InternalConsumption'
        AND NOT EXISTS (
          SELECT 1 FROM "InternalConsumptionItem" i WHERE i."consumptionId" = ic.id
        )`,
  );
  if (huerfanos[0].n > 0) {
    console.log(
      `⚠ ${huerfanos[0].n} consumo(s) vinculados no tienen ítems cargados.`,
    );
    avisos++;
  }

  // 5. Autor de cada asiento: es lo que hace auditable el libro.
  const { rows: autores } = await client.query(
    `SELECT COUNT(*) FILTER (WHERE e."createdById" IS NULL)::int AS sin_autor,
            COUNT(*) FILTER (
              WHERE e."createdById" IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM "User" x WHERE x.id = e."createdById")
            )::int AS autor_inexistente
       FROM "StaffLedgerEntry" e`,
  );
  const a = autores[0];
  if (a.sin_autor > 0 || a.autor_inexistente > 0) {
    console.log(
      `⚠ ${a.sin_autor} sin autor y ${a.autor_inexistente} con un autor que ya no existe:` +
        `\n  en esos, el extracto va a mostrar un guion en "quién lo registró".`,
    );
    avisos++;
  } else {
    console.log("✔ Todos los movimientos tienen un autor que existe.");
  }

  console.log(
    avisos === 0
      ? "\n✔ Los datos soportan todo lo que la pantalla promete.\n"
      : `\n${avisos} aviso(s): la pantalla funciona, pero hay huecos en los datos.\n`,
  );
  await client.end();
})().catch(async (e) => {
  console.error(e.message);
  try {
    await client.end();
  } catch {
    /* ya cerrada */
  }
  process.exit(1);
});

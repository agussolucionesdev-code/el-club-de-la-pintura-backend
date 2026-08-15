/**
 * Realinea los checksums de _prisma_migrations en la BASE DE TESTS.
 *
 * Por qué existe: si un archivo de migración ya aplicado se edita después,
 * Prisma detecta deriva y exige `migrate reset` — que destruye la base entera.
 * Acá el arreglo es puntual: se recalcula el SHA-256 del archivo y se actualiza
 * la fila. No se toca ni una tabla de datos.
 *
 * Guard: aborta si la base no termina en "_test".
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

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

const client = new Client({ connectionString: url });

(async () => {
  await client.connect();
  const dir = path.resolve("prisma/migrations");
  const { rows } = await client.query(
    "SELECT migration_name, checksum FROM _prisma_migrations ORDER BY migration_name",
  );

  let corregidos = 0;
  for (const fila of rows) {
    const archivo = path.join(dir, fila.migration_name, "migration.sql");
    if (!fs.existsSync(archivo)) {
      console.log(`sin archivo local: ${fila.migration_name}`);
      continue;
    }
    const real = crypto
      .createHash("sha256")
      .update(fs.readFileSync(archivo))
      .digest("hex");
    if (real !== fila.checksum) {
      await client.query(
        "UPDATE _prisma_migrations SET checksum = $1 WHERE migration_name = $2",
        [real, fila.migration_name],
      );
      console.log(`checksum actualizado: ${fila.migration_name}`);
      corregidos += 1;
    }
  }
  console.log(`base "${nombre}" — corregidos ${corregidos} de ${rows.length}`);
  await client.end();
})().catch(async (error) => {
  console.error(error.message);
  await client.end().catch(() => {});
  process.exit(1);
});

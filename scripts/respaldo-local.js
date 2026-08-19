/**
 * Respaldo de la base, desde tu propia máquina.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * Hay un respaldo automático en GitHub Actions (`.github/workflows/backup.yml`)
 * y está bien hecho: corre todos los días, verifica el dump y lo guarda 90 días.
 * Pero necesita el secreto `PRODUCTION_DATABASE_URL` configurado en el
 * repositorio, y **mientras ese secreto no exista, falla todos los días**.
 *
 * Verificado el 19/08/2026: cinco corridas, cinco fallos, todas con el mismo
 * motivo — "Falta el secreto PRODUCTION_DATABASE_URL". O sea: cero respaldos.
 *
 * Este script no depende de nada de eso. Lee la URL del `.env` que ya tenés y
 * escribe el respaldo acá. Sirve como red mientras el automático no ande, y
 * como respaldo a mano antes de cualquier operación riesgosa.
 *
 * ── Por qué no usa pg_dump ──────────────────────────────────────────────────
 *
 * Porque `pg_dump` no está instalado en esta máquina, y pedirte que instales
 * PostgreSQL entero para poder respaldar es una barrera que termina en "lo hago
 * mañana". Esto usa el cliente que el proyecto ya tiene.
 *
 * ── Qué garantiza y qué no ──────────────────────────────────────────────────
 *
 *   SÍ: todas las filas de todas las tablas, en un archivo comprimido, con un
 *       conteo por tabla para verificar que no quedó cortado.
 *   NO: es un respaldo LÓGICO de datos, no un dump SQL restaurable de una sola
 *       orden. Para restaurar hay que reinsertarlo con un script. Sirve para no
 *       perder la información, que es lo que importa cuando no hay nada.
 *
 * Uso:
 *   npm run respaldo             → respalda la base de PRODUCCIÓN (sólo lectura)
 *   npm run respaldo -- --test   → respalda la base de tests
 *
 * SÓLO EJECUTA SELECT. La conexión se abre en modo de sólo lectura para que el
 * motor rechace cualquier escritura, incluso por un error de programación.
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { Client } = require("pg");

const usarTests = process.argv.includes("--test");

require("dotenv").config(
  usarTests ? { path: path.join(__dirname, "..", ".env.test.local") } : {},
);

const url = usarTests ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;

if (!url) {
  console.error(
    usarTests
      ? "Falta TEST_DATABASE_URL en .env.test.local."
      : "Falta DATABASE_URL en .env.",
  );
  process.exit(1);
}

const nombreBase = decodeURIComponent(
  new URL(url).pathname.replace(/^\//u, ""),
);

/** Dónde se guarda. Fuera del repo para que no se commitee por accidente. */
const DESTINO = process.env.BACKUP_DIR || path.join(__dirname, "..", "respaldos");

/** Cuántos respaldos conservar. Los más viejos se borran solos. */
const RETENCION = Number(process.env.RETENCION || 14);

const client = new Client({ connectionString: url });

/** Las tablas del esquema público, en orden alfabético y estable. */
const listarTablas = async () => {
  const { rows } = await client.query(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
      ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename);
};

const main = async () => {
  await client.connect();
  // Sólo lectura a nivel motor: un INSERT acá falla, no importa qué diga el
  // código de abajo.
  await client.query("SET default_transaction_read_only = on");

  console.log(`\nBase: ${nombreBase}${usarTests ? "  (tests)" : "  (PRODUCCIÓN)"}\n`);

  const tablas = await listarTablas();
  const contenido = { base: nombreBase, tomadoEl: new Date().toISOString(), tablas: {} };
  const conteos = {};
  let filasTotales = 0;

  for (const tabla of tablas) {
    // El nombre va entre comillas: el esquema usa PascalCase y sin comillas
    // Postgres lo pasaría a minúsculas y no encontraría la tabla.
    const { rows } = await client.query(`SELECT * FROM "${tabla}"`);
    contenido.tablas[tabla] = rows;
    conteos[tabla] = rows.length;
    filasTotales += rows.length;
    if (rows.length > 0) {
      console.log(`  ${tabla.padEnd(28)} ${String(rows.length).padStart(7)} filas`);
    }
  }

  contenido.conteos = conteos;

  fs.mkdirSync(DESTINO, { recursive: true });
  const marca = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
  const archivo = path.join(DESTINO, `respaldo-${nombreBase}-${marca}.json.gz`);

  // `bigint` no se serializa solo, y esta base los usa en los conteos.
  const json = JSON.stringify(contenido, (_k, v) =>
    typeof v === "bigint" ? String(v) : v,
  );
  fs.writeFileSync(archivo, zlib.gzipSync(json, { level: 9 }));

  // ── Verificar que el respaldo sirve ──
  // Un respaldo que nadie probó no es un respaldo: es un archivo.
  const releido = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(archivo)).toString("utf8"),
  );
  const tablasReleidas = Object.keys(releido.tablas ?? {});
  const filasReleidas = Object.values(releido.conteos ?? {}).reduce(
    (a, b) => a + b,
    0,
  );

  if (tablasReleidas.length !== tablas.length || filasReleidas !== filasTotales) {
    console.error(
      `\n✘ El respaldo no verifica: se guardaron ${tablas.length} tablas / ` +
        `${filasTotales} filas y se releyeron ${tablasReleidas.length} / ${filasReleidas}.`,
    );
    process.exit(1);
  }

  const tam = (fs.statSync(archivo).size / 1024 / 1024).toFixed(2);
  console.log(
    `\n✔ Respaldo verificado: ${tablas.length} tablas, ` +
      `${filasTotales.toLocaleString("es-AR")} filas, ${tam} MB`,
  );
  console.log(`  ${archivo}`);

  // ── Retención ──
  const viejos = fs
    .readdirSync(DESTINO)
    .filter((f) => f.startsWith(`respaldo-${nombreBase}-`) && f.endsWith(".json.gz"))
    .sort()
    .reverse()
    .slice(RETENCION);
  for (const f of viejos) {
    fs.unlinkSync(path.join(DESTINO, f));
    console.log(`  (se borró el respaldo viejo ${f})`);
  }

  await client.end();
};

main().catch(async (e) => {
  console.error("\n✘ El respaldo FALLÓ:", e.message);
  try {
    await client.end();
  } catch {
    /* ya cerrada */
  }
  process.exit(1);
});

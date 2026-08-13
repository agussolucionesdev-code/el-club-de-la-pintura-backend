/* eslint-disable */
/**
 * Corre un comando de Prisma contra la BASE DE TESTS, nunca contra producción.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * El `.env` de este repo tiene `DATABASE_URL` apuntando a la base REAL, así que
 * un `npx prisma migrate deploy` tipeado de memoria le pega a los datos del
 * negocio. Pasó de verdad: once migraciones —una de ellas poniendo una columna
 * en NOT NULL— se aplicaron a producción sin autorización ni respaldo previo.
 *
 * `prisma.config.ts` tiene el candado que lo frena; esto es el camino correcto
 * para trabajar todos los días.
 *
 * Uso:
 *   npm run db:migrate:test          → migrate deploy
 *   npm run db:status:test           → migrate status
 *   node scripts/prisma-against-test-db.js migrate diff --from-... → cualquier otro
 */

const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

require("dotenv").config({ path: path.join(ROOT, ".env.test.local") });

const testUrl = (process.env.TEST_DATABASE_URL || "").trim();

if (!testUrl) {
  console.error(
    "\n[PRISMA:TEST] Falta TEST_DATABASE_URL en .env.test.local.\n" +
      "Sin una base de tests declarada no se corre nada: el .env apunta a producción.\n",
  );
  process.exit(1);
}

let dbName;
try {
  dbName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, "")).trim();
} catch {
  console.error("\n[PRISMA:TEST] TEST_DATABASE_URL no es una URL de PostgreSQL válida.\n");
  process.exit(1);
}

if (!/_test$/.test(dbName)) {
  console.error(
    `\n[PRISMA:TEST] La base declarada se llama "${dbName}" y no termina en _test.\n` +
      "Se aborta antes de tocar nada.\n",
  );
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("\n[PRISMA:TEST] Falta el comando. Ejemplo: migrate deploy\n");
  process.exit(1);
}

console.log(`[PRISMA:TEST] prisma ${args.join(" ")} → base de tests "${dbName}".\n`);

// Se resuelve el binario de Prisma y se lanza con el propio Node en vez de
// `npx`: en Windows, `npx` es un `.cmd` y Node lo rechaza sin `shell: true`.
const prismaBin = require.resolve("prisma/build/index.js");

const child = spawn(process.execPath, [prismaBin, ...args], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: testUrl },
});

child.on("exit", (code) => process.exit(code ?? 0));

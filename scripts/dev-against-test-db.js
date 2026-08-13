/* eslint-disable */
/**
 * Levanta el servidor de desarrollo apuntando a la BASE DE TESTS, nunca a
 * producción.
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 *
 * El `.env` local de este repo apunta a la base `neondb`, que es la de
 * PRODUCCIÓN. Correr `npm run dev` para probar algo a mano significa que cada
 * venta de prueba, cada turno abierto y cada producto inventado quedan en los
 * datos reales del negocio. Con dos sucursales operando de verdad, eso no es un
 * riesgo teórico.
 *
 * Este arranque fuerza `DATABASE_URL` a la rama de tests de Neon ANTES de que
 * el proceso cargue nada. `dotenv` no pisa variables ya definidas, así que el
 * `.env` no puede volver a apuntarlo a producción.
 *
 * Uso:  npm run dev:test
 */

const { spawn } = require("node:child_process");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// 1. Se lee ÚNICAMENTE el archivo de la base de tests.
require("dotenv").config({ path: path.join(ROOT, ".env.test.local") });

const testUrl = (process.env.TEST_DATABASE_URL || "").trim();

if (!testUrl) {
  console.error(
    "\n[DEV:TEST] Falta TEST_DATABASE_URL en .env.test.local.\n" +
      "Sin una base de tests declarada no se levanta nada: el .env apunta a producción.\n",
  );
  process.exit(1);
}

// 2. Se confirma que el nombre de la base termine en _test. Misma regla que el
//    guard de la suite: la única forma de distinguir tests de producción.
let dbName;
try {
  dbName = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, "")).trim();
} catch {
  console.error("\n[DEV:TEST] TEST_DATABASE_URL no es una URL de PostgreSQL válida.\n");
  process.exit(1);
}

if (!/_test$/.test(dbName)) {
  console.error(
    `\n[DEV:TEST] La base declarada se llama "${dbName}" y no termina en _test.\n` +
      "Se aborta antes de levantar el servidor.\n",
  );
  process.exit(1);
}

// 3. Recién ahora se apunta el proceso a la base de tests.
console.log(`[DEV:TEST] Servidor de desarrollo contra la base de tests "${dbName}".`);
console.log("[DEV:TEST] La base de PRODUCCIÓN no se toca.\n");

// Se resuelve el binario de nodemon y se lanza con el propio Node, en vez de
// invocar `npx`. En Windows, `npx` es un `.cmd` y Node moderno rechaza
// spawnearlo sin `shell: true` (EINVAL). Esto evita el shell por completo y
// funciona igual en Windows, macOS y Linux.
const nodemonBin = require.resolve("nodemon/bin/nodemon.js");

const child = spawn(process.execPath, [nodemonBin, "src/app.ts"], {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: testUrl,
    NODE_ENV: "development",
  },
});

child.on("exit", (code) => process.exit(code ?? 0));

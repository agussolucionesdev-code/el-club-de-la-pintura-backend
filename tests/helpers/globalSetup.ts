/**
 * Jest `globalSetup` — corre UNA sola vez, antes del primer archivo de test.
 *
 * Es la mitad fuerte del guard: valida el entorno y después **se conecta de
 * verdad** y le pregunta al servidor a qué base está conectado. Una cadena de
 * conexión puede mentir o redirigir; `SELECT current_database()` no.
 *
 * Si algo queda inconcluso, esto lanza y Jest aborta la corrida ENTERA antes de
 * que ningún test migre, trunque, siembre o escriba una sola fila.
 *
 * Usa `pg` directo y no el cliente de `src/config/db.ts`: para una sola consulta
 * de verificación no hace falta arrastrar el adapter ni las extensiones de
 * Prisma, y el guard queda desacoplado de los internals de la aplicación.
 */

import { Pool } from "pg";

import { loadTestEnv } from "./loadTestEnv";
import {
  assertReportedDatabase,
  assertTestDatabaseEnv,
  sharesTargetWithConfiguredDatabase,
} from "./testDatabaseGuard";

/**
 * Saca un motivo legible de un fallo de conexión de `pg`. Devuelve códigos y
 * mensajes de red (ECONNREFUSED, ENOTFOUND, timeout), nunca host, usuario ni
 * contraseña — el objetivo es que quien lea el error sepa qué arreglar sin que
 * la credencial termine en un log o en una captura de CI.
 */
const describeConnectionError = (error: unknown): string => {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const causes = error.errors
      .map((inner) => {
        const code = (inner as NodeJS.ErrnoException)?.code;
        const message = inner instanceof Error ? inner.message : String(inner);
        return code ?? message;
      })
      .filter((value, index, all) => value && all.indexOf(value) === index);
    return causes.join(", ") || "AggregateError sin detalle";
  }

  if (error instanceof Error) {
    // El código primero, a propósito: el mensaje de Node para fallos de DNS es
    // "getaddrinfo ENOTFOUND <host>" e incluiría el host en cualquier log de CI.
    // "ENOTFOUND" dice exactamente lo mismo para quien tiene que arreglarlo.
    const code = (error as NodeJS.ErrnoException).code;
    return code || error.message || error.name;
  }

  return String(error);
};

export default async function globalSetup(): Promise<void> {
  // `globalSetup` corre en su propio contexto: `setupFiles` todavía no se
  // ejecutó para ningún archivo, así que NODE_ENV puede no venir puesto.
  process.env.NODE_ENV = "test";
  loadTestEnv();

  const declared = assertTestDatabaseEnv();

  // Aviso, no rechazo: en CI hay una sola base efímera y las dos variables
  // apuntan ahí a propósito. Localmente, saber que la suite está por escribir
  // sobre la misma base que usás para desarrollar evita una sorpresa.
  if (sharesTargetWithConfiguredDatabase()) {
    console.log(
      `[GUARD DE TESTS] Aviso: DATABASE_URL apunta a la misma base "${declared.database}". ` +
        "Es lo esperado en CI; en local significa que la suite va a reescribir esos datos.",
    );
  }

  // Se apunta explícitamente a la base de tests ya validada, sin depender de
  // lo que hubiera en DATABASE_URL.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    // Un host equivocado tiene que fallar rápido, no colgar la corrida.
    connectionTimeoutMillis: 10_000,
    max: 1,
  });

  try {
    let result;
    try {
      result = await pool.query<{ current_database: string }>(
        "SELECT current_database()",
      );
    } catch (error) {
      // `pg` envuelve los fallos de conexión en un AggregateError cuyo
      // `.message` viene vacío: lo útil (ECONNREFUSED, ENOTFOUND, timeout) está
      // en `.errors`. Se traduce a algo accionable, nombrando la base pero
      // nunca el host ni las credenciales.
      throw new Error(
        `[GUARD DE TESTS] No se pudo conectar a la base de tests "${declared.database}". ` +
          "Verificá que TEST_DATABASE_URL apunte a un servidor accesible " +
          `(rama de Neon dedicada o Postgres local). Detalle: ${describeConnectionError(error)}`,
      );
    }

    const reported = result.rows[0]?.current_database;
    if (!reported) {
      throw new Error(
        "[GUARD DE TESTS] El servidor no devolvió el nombre de la base actual. " +
          "Se aborta: sin confirmación no se escribe.",
      );
    }

    assertReportedDatabase(reported, declared);

    // Se confirma el destino por nombre. Host, usuario y credenciales no se
    // imprimen nunca, ni siquiera en el camino feliz.
    console.log(`[GUARD DE TESTS] Conectado a la base de tests "${reported}".`);
  } finally {
    await pool.end();
  }
}

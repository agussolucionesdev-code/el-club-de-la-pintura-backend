/**
 * Guard de base de datos para la suite de tests.
 *
 * Los tests de este repositorio escriben contra un PostgreSQL real: crean
 * sucursales, usuarios, productos, ventas y turnos de caja. Apuntar la suite a
 * la base equivocada no da un error — da datos de prueba mezclados con datos
 * del negocio, y Neon no tiene backups.
 *
 * Validar la cadena de conexión NO prueba a qué base apuntás: la URL puede
 * mentir, redirigir o haber sido copiada a medias. Por eso el guard tiene dos
 * mitades:
 *
 *   1. Este módulo — chequeos sincrónicos sobre el entorno, antes de que se
 *      importe cualquier módulo de la aplicación (`setupFiles`).
 *   2. `globalSetup.ts` — conexión real y `SELECT current_database()`, una sola
 *      vez, ANTES de que corra el primer archivo de test.
 *
 * Regla de secretos: en los mensajes de error se nombra únicamente el NOMBRE de
 * la base, que es justamente el dato que hay que corregir. Host, usuario,
 * contraseña y query string no se imprimen nunca.
 */

/** El nombre de la base tiene que terminar en `_test`. Sin excepciones. */
export const TEST_DB_NAME_PATTERN = /_test$/;

export type PostgresTarget = {
  host: string;
  port: string;
  database: string;
};

/**
 * Extrae host/puerto/base de una URL de Postgres, normalizados para comparar.
 * Devuelve `null` si no parsea o no es un esquema de Postgres — nunca lanza,
 * porque quien llama decide qué mensaje mostrar sin filtrar la URL.
 */
export const parsePostgresUrl = (raw: string): PostgresTarget | null => {
  try {
    const url = new URL(raw.trim());
    if (!/^postgres(ql)?:$/u.test(url.protocol)) return null;

    const database = decodeURIComponent(url.pathname.replace(/^\//u, "")).trim();
    if (!database) return null;

    return {
      host: url.hostname.toLowerCase(),
      // Postgres asume 5432 cuando el puerto no viene explícito; normalizarlo
      // evita que "host/db" y "host:5432/db" parezcan bases distintas.
      port: url.port || "5432",
      database: database.toLowerCase(),
    };
  } catch {
    return null;
  }
};

/** Dos URLs apuntan al mismo lugar aunque difieran en usuario o parámetros. */
export const isSameTarget = (a: PostgresTarget, b: PostgresTarget): boolean =>
  a.host === b.host && a.port === b.port && a.database === b.database;

export class TestDatabaseGuardError extends Error {
  constructor(message: string) {
    super(`[GUARD DE TESTS] ${message}`);
    this.name = "TestDatabaseGuardError";
  }
}

/**
 * Chequeos sincrónicos. Corre antes de que se importe un solo módulo de la app,
 * así que ninguna migración, truncado, seed ni escritura de test puede haber
 * ocurrido todavía cuando esto falla.
 *
 * Devuelve el destino declarado para que `globalSetup` lo contraste contra lo
 * que el servidor efectivamente reporta.
 */
export const assertTestDatabaseEnv = (
  env: NodeJS.ProcessEnv = process.env,
): PostgresTarget => {
  if (env.NODE_ENV !== "test") {
    throw new TestDatabaseGuardError(
      `NODE_ENV tiene que ser "test" para correr la suite (llegó "${env.NODE_ENV ?? "sin definir"}").`,
    );
  }

  const raw = env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    // Sin fallback a DATABASE_URL: si la variable dedicada no está, la suite no
    // corre. El fallback es exactamente el camino por el que un test termina
    // escribiendo en producción.
    throw new TestDatabaseGuardError(
      "Falta TEST_DATABASE_URL. La suite NO cae por defecto a DATABASE_URL: " +
        "definí una base de tests dedicada cuyo nombre termine en _test.",
    );
  }

  const target = parsePostgresUrl(raw);
  if (!target) {
    throw new TestDatabaseGuardError(
      "TEST_DATABASE_URL no es una URL de PostgreSQL válida con nombre de base.",
    );
  }

  if (!TEST_DB_NAME_PATTERN.test(target.database)) {
    throw new TestDatabaseGuardError(
      `La base declarada en TEST_DATABASE_URL se llama "${target.database}" y no termina en _test. ` +
        "La suite borra y reescribe datos: sólo corre contra una base de tests.",
    );
  }

  return target;
};

/**
 * ¿TEST_DATABASE_URL apunta al mismo host+puerto+base que DATABASE_URL?
 *
 * Es **informativo, no un motivo de rechazo**. En CI hay una sola base efímera
 * y las dos variables apuntan ahí legítimamente: `prisma migrate deploy` lee
 * DATABASE_URL, y esa base ES la de tests.
 *
 * La protección real contra escribir donde no corresponde son las otras dos
 * reglas, y no ésta: el nombre tiene que terminar en `_test`, y el servidor
 * tiene que confirmarlo por `SELECT current_database()`. Dado que la primera
 * ya se exige, que ambas variables coincidan sólo puede ocurrir cuando las dos
 * miran una base `_test` — o sea, nunca producción.
 */
export const sharesTargetWithConfiguredDatabase = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const test = env.TEST_DATABASE_URL?.trim()
    ? parsePostgresUrl(env.TEST_DATABASE_URL)
    : null;
  const configured = env.DATABASE_URL?.trim()
    ? parsePostgresUrl(env.DATABASE_URL)
    : null;

  return Boolean(test && configured && isSameTarget(test, configured));
};

/**
 * Contrasta lo que el servidor dice ser contra lo que la URL prometía.
 * Se llama con el resultado real de `SELECT current_database()`.
 */
export const assertReportedDatabase = (
  reported: string,
  declared: PostgresTarget,
): void => {
  const actual = reported.trim().toLowerCase();

  if (!TEST_DB_NAME_PATTERN.test(actual)) {
    throw new TestDatabaseGuardError(
      `El servidor reporta estar conectado a "${actual}", que no termina en _test. ` +
        "Se aborta antes de escribir nada.",
    );
  }

  if (actual !== declared.database) {
    throw new TestDatabaseGuardError(
      `TEST_DATABASE_URL declara la base "${declared.database}" pero el servidor ` +
        `reporta "${actual}". No se escribe sobre un destino que no es el esperado.`,
    );
  }
};

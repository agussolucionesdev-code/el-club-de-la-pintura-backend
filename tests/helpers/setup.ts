/**
 * Jest `setupFiles` — corre antes de cada archivo de test, antes de que se
 * importe cualquier módulo de la aplicación.
 *
 * Acá van sólo las variables de entorno y los chequeos sincrónicos. La
 * verificación fuerte (conectarse y preguntarle al servidor a qué base está
 * conectado) vive en `globalSetup.ts`, que corre UNA vez antes que todo esto.
 */

import { loadTestEnv } from "./loadTestEnv";
import { assertTestDatabaseEnv } from "./testDatabaseGuard";

// Trae TEST_DATABASE_URL desde .env.test.local si no vino ya por entorno.
loadTestEnv();

// Secreto estable y conocido para firmar y verificar tokens en los tests.
// Pisa cualquier secreto real de .env: la suite tiene que ser hermética.
process.env.JWT_SECRET = "test-secret-el-club-pintura-do-not-use-in-production-32chars+";
process.env.NODE_ENV = "test";

// Falla el archivo de test si el entorno no es seguro. No hay fallback a
// DATABASE_URL: si TEST_DATABASE_URL no está, no se corre nada.
assertTestDatabaseEnv();

// Recién ahora se apunta el cliente de Prisma a la base de tests, ya validada.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

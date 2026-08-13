/**
 * El guard que impide que la suite escriba en la base equivocada.
 *
 * Estos tests son puros: le inyectan un entorno falso a las funciones y no
 * tocan ninguna base. Prueban la mitad sincrónica del guard y la comparación
 * final contra lo que el servidor reporta.
 */

import {
  assertReportedDatabase,
  assertTestDatabaseEnv,
  isSameTarget,
  parsePostgresUrl,
  sharesTargetWithConfiguredDatabase,
  TestDatabaseGuardError,
} from "./helpers/testDatabaseGuard";

const TEST_URL = "postgresql://user:pass@localhost:5432/el_club_test";
const PROD_URL = "postgresql://owner:secret@ep-cool-name.neon.tech/el_club_prod?sslmode=require";

const envWith = (overrides: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  ({ NODE_ENV: "test", TEST_DATABASE_URL: TEST_URL, ...overrides }) as NodeJS.ProcessEnv;

describe("Guard de la base de tests", () => {
  describe("parsePostgresUrl", () => {
    it("normaliza host, puerto y nombre de base", () => {
      expect(parsePostgresUrl(TEST_URL)).toEqual({
        host: "localhost",
        port: "5432",
        database: "el_club_test",
      });
    });

    it("asume el puerto 5432 cuando no viene explícito", () => {
      const target = parsePostgresUrl("postgresql://u:p@db.example.com/el_club_test");
      expect(target?.port).toBe("5432");
    });

    it("ignora la query string al identificar el destino", () => {
      const target = parsePostgresUrl(`${TEST_URL}?sslmode=require&connect_timeout=10`);
      expect(target?.database).toBe("el_club_test");
    });

    it("devuelve null si no es una URL de Postgres o no tiene base", () => {
      expect(parsePostgresUrl("mysql://u:p@localhost/el_club_test")).toBeNull();
      expect(parsePostgresUrl("postgresql://u:p@localhost:5432/")).toBeNull();
      expect(parsePostgresUrl("no-es-una-url")).toBeNull();
    });
  });

  describe("isSameTarget", () => {
    it("reconoce el mismo destino aunque cambien usuario y parámetros", () => {
      const a = parsePostgresUrl("postgresql://alguien:x@host:5432/el_club_test")!;
      const b = parsePostgresUrl("postgresql://otro:y@host:5432/el_club_test?sslmode=require")!;
      expect(isSameTarget(a, b)).toBe(true);
    });

    it("distingue bases distintas en el mismo servidor", () => {
      const a = parsePostgresUrl("postgresql://u:p@host:5432/el_club_test")!;
      const b = parsePostgresUrl("postgresql://u:p@host:5432/el_club_prod")!;
      expect(isSameTarget(a, b)).toBe(false);
    });
  });

  describe("assertTestDatabaseEnv", () => {
    it("acepta un entorno correcto y devuelve el destino declarado", () => {
      expect(assertTestDatabaseEnv(envWith({})).database).toBe("el_club_test");
    });

    it("rechaza si NODE_ENV no es test", () => {
      expect(() => assertTestDatabaseEnv(envWith({ NODE_ENV: "development" }))).toThrow(
        TestDatabaseGuardError,
      );
    });

    it("rechaza si falta TEST_DATABASE_URL — no cae por defecto a DATABASE_URL", () => {
      const env = envWith({ TEST_DATABASE_URL: undefined, DATABASE_URL: PROD_URL });
      expect(() => assertTestDatabaseEnv(env)).toThrow(/Falta TEST_DATABASE_URL/u);
    });

    it("rechaza una base cuyo nombre no termina en _test", () => {
      const env = envWith({ TEST_DATABASE_URL: PROD_URL });
      expect(() => assertTestDatabaseEnv(env)).toThrow(/no termina en _test/u);
    });

    it("NO rechaza cuando ambas variables apuntan a la misma base _test", () => {
      // Es el layout legítimo del CI: una sola base efímera, que `migrate
      // deploy` necesita en DATABASE_URL y la suite en TEST_DATABASE_URL.
      // La protección real es el sufijo _test más la confirmación del servidor.
      const env = envWith({
        TEST_DATABASE_URL: "postgresql://u:p@host:5432/el_club_test",
        DATABASE_URL: "postgresql://otro:otra@host:5432/el_club_test?sslmode=require",
      });
      expect(assertTestDatabaseEnv(env).database).toBe("el_club_test");
    });

    it("permite una rama de Neon dedicada mientras se llame _test", () => {
      const env = envWith({
        TEST_DATABASE_URL: "postgresql://u:p@ep-branch.neon.tech/el_club_test?sslmode=require",
        DATABASE_URL: PROD_URL,
      });
      expect(assertTestDatabaseEnv(env).database).toBe("el_club_test");
    });

    it("no filtra host ni credenciales en el mensaje de error", () => {
      const env = envWith({ TEST_DATABASE_URL: PROD_URL });
      try {
        assertTestDatabaseEnv(env);
        throw new Error("debería haber lanzado");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain("secret");
        expect(message).not.toContain("owner");
        expect(message).not.toContain("neon.tech");
        expect(message).toContain("el_club_prod"); // el nombre sí: es lo que hay que corregir
      }
    });
  });

  describe("sharesTargetWithConfiguredDatabase", () => {
    it("detecta que ambas variables miran la misma base (aviso, no rechazo)", () => {
      const env = envWith({
        TEST_DATABASE_URL: "postgresql://u:p@host:5432/el_club_test",
        DATABASE_URL: "postgresql://otro:otra@host:5432/el_club_test?sslmode=require",
      });
      expect(sharesTargetWithConfiguredDatabase(env)).toBe(true);
    });

    it("devuelve false cuando apuntan a bases distintas", () => {
      expect(sharesTargetWithConfiguredDatabase(envWith({ DATABASE_URL: PROD_URL }))).toBe(false);
    });

    it("devuelve false cuando DATABASE_URL no está definida", () => {
      expect(sharesTargetWithConfiguredDatabase(envWith({ DATABASE_URL: undefined }))).toBe(false);
    });
  });

  describe("assertReportedDatabase", () => {
    const declared = parsePostgresUrl(TEST_URL)!;

    it("acepta cuando el servidor confirma la base declarada", () => {
      expect(() => assertReportedDatabase("el_club_test", declared)).not.toThrow();
    });

    it("rechaza si el servidor reporta una base que no termina en _test", () => {
      expect(() => assertReportedDatabase("el_club_prod", declared)).toThrow(/no termina en _test/u);
    });

    it("rechaza si el servidor reporta otra base que la declarada — la URL mintió", () => {
      expect(() => assertReportedDatabase("otra_base_test", declared)).toThrow(
        /pero el servidor reporta/u,
      );
    });
  });
});

/**
 * Test auth helper — generates JWT tokens for test users directly,
 * without going through the login endpoint.
 *
 * This bypasses the login HTTP layer so tests are not coupled to the
 * session-cookie implementation. The middleware accepts Bearer tokens
 * as a fallback to HttpOnly cookies (auth.middleware.ts).
 */
import jwt from "jsonwebtoken";

const TEST_SECRET = process.env.JWT_SECRET ?? "test-secret-do-not-use-in-production";

export interface TestTokenPayload {
  userId: number;
  role: "ADMIN" | "ENCARGADO" | "EMPLOYEE";
  branchIds: number[];
  /**
   * Cómo se probó la identidad: con contraseña, o con el código de una terminal.
   *
   * Se omite en casi todos los tests a propósito. Un token sin este campo se
   * lee como `PASSWORD`, que es exactamente cómo se comportaban los tokens
   * antes de que existiera el ingreso por código — así que omitirlo también
   * comprueba esa compatibilidad hacia atrás.
   */
  authLevel?: "PASSWORD" | "PIN";
}

/**
 * Returns a signed JWT for use in test requests.
 * Usage:
 *   const token = generateTestToken({ userId: operator.id, role: "ENCARGADO", branchIds: [branchId] });
 *   .set("Authorization", `Bearer ${token}`)
 */
export function generateTestToken({
  userId,
  role,
  branchIds,
  authLevel,
}: TestTokenPayload): string {
  return jwt.sign(
    { id: userId, role, branchIds, ...(authLevel ? { authLevel } : {}) },
    TEST_SECRET,
    { expiresIn: "1h" },
  );
}

/**
 * Saca el token de sesión de las cabeceras `Set-Cookie` de una respuesta.
 *
 * Existe para que los tests no repitan el `split(";")[0].split("=")[1]`, que
 * bajo `noUncheckedIndexedAccess` hay que defender en cada uso y termina
 * enterrando lo que el test realmente quiere decir.
 */
export function sessionTokenFromResponse(res: {
  headers: Record<string, unknown>;
}): string {
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? (raw as string[]) : [];
  const sesion = cookies.find((cookie) => cookie.startsWith("club_token="));

  if (!sesion) throw new Error("La respuesta no trae cookie de sesión.");

  const token = sesion.split(";")[0]?.split("=")[1];
  if (!token) throw new Error("La cookie de sesión vino vacía.");

  return token;
}

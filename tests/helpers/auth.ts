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
}

/**
 * Returns a signed JWT for use in test requests.
 * Usage:
 *   const token = generateTestToken({ userId: operator.id, role: "ENCARGADO", branchIds: [branchId] });
 *   .set("Authorization", `Bearer ${token}`)
 */
export function generateTestToken({ userId, role, branchIds }: TestTokenPayload): string {
  return jwt.sign(
    { id: userId, role, branchIds },
    TEST_SECRET,
    { expiresIn: "1h" },
  );
}

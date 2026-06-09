/**
 * Jest global setup — runs before each test file.
 * Sets environment variables that must be available before any module is imported.
 */

// Use a stable, known secret for all test token generation and verification.
// This overrides any real secret from .env so tests are hermetic.
process.env.JWT_SECRET = "test-secret-el-club-pintura-do-not-use-in-production-32chars+";
process.env.NODE_ENV = "test";

// SAFETY GUARD: prevent tests from running against the production database.
// Tests MUST use TEST_DATABASE_URL. If only DATABASE_URL is set (and it points
// to Neon/production), tests would create and leak data into the real DB.
//
// To run tests: set TEST_DATABASE_URL in your .env.test or environment, e.g.:
//   TEST_DATABASE_URL=postgresql://localhost:5432/el_club_test
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else if (process.env.DATABASE_URL?.includes("neon.tech") || process.env.DATABASE_URL?.includes("render.com")) {
  throw new Error(
    "[SAFETY] Tests would run against production DB. " +
    "Set TEST_DATABASE_URL in your environment to a local/test database. " +
    "Never run tests against the production Neon database."
  );
}

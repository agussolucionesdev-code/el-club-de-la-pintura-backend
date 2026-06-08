/**
 * Jest global setup — runs before each test file.
 * Sets environment variables that must be available before any module is imported.
 */

// Use a stable, known secret for all test token generation and verification.
// This overrides any real secret from .env so tests are hermetic.
process.env.JWT_SECRET = "test-secret-el-club-pintura-do-not-use-in-production-32chars+";
process.env.NODE_ENV = "test";

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  testTimeout: 30000,
  // Ensure a known JWT_SECRET is available for token signing in tests.
  // The real .env value is NOT loaded by Jest — tests must be hermetic.
  testEnvironmentOptions: {},
  setupFiles: ["<rootDir>/tests/helpers/setup.ts"],
};

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
  // Corre UNA vez antes del primer archivo de test: se conecta de verdad y
  // verifica con SELECT current_database() que la base sea la de tests. Aborta
  // la corrida entera antes de que nada escriba si el destino no se confirma.
  globalSetup: "<rootDir>/tests/helpers/globalSetup.ts",
};

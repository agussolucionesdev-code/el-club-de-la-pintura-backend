/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  // Le decimos al robot dónde buscar los archivos de prueba
  roots: ["<rootDir>/tests"],
  // Ignoramos la carpeta de compilación por si acaso
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
};

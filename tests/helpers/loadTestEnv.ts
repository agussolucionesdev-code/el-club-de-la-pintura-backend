/**
 * Carga las credenciales de la base de tests desde `.env.test.local`.
 *
 * Ese archivo está en `.gitignore` y nunca se commitea: contiene la cadena de
 * conexión real de la rama de Neon dedicada a tests. Tenerlo en un archivo
 * aparte evita el patrón de pegar la URL en cada comando, que es como las
 * credenciales terminan en el historial de la terminal.
 *
 * `override: false` es deliberado: si la variable ya viene del entorno —como en
 * CI, donde la define el workflow— gana el entorno y este archivo se ignora.
 */

import path from "node:path";

import dotenv from "dotenv";

let loaded = false;

export const loadTestEnv = (): void => {
  if (loaded) return;
  loaded = true;

  dotenv.config({
    path: path.resolve(__dirname, "../../.env.test.local"),
    override: false,
  });
};

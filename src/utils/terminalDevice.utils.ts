/**
 * Credencial de dispositivo de una terminal.
 *
 * ── El problema que resuelve ────────────────────────────────────────────────
 *
 * Mientras la terminal se declare en el cuerpo del request, la atribución es
 * una promesa, no una garantía: cualquiera con una sesión válida puede mandar
 * `terminalId: 7` y hacer que sus ventas figuren en otra caja. Con incentivos
 * por vendedor de por medio, eso es plata.
 *
 * La terminal tiene que probarse con algo que **el servidor emitió**, no con un
 * número que el cliente afirma.
 *
 * ── Cómo funciona ───────────────────────────────────────────────────────────
 *
 * 1. El admin crea la terminal y emite un **token de enrolamiento de un solo
 *    uso**. Se muestra UNA vez; en la base va hasheado.
 * 2. En esa computadora se canjea el token por un **secreto de dispositivo**,
 *    que viaja en una cookie `HttpOnly` — inaccesible para JavaScript, así que
 *    un XSS no puede robarlo ni fabricarlo.
 * 3. Cada request del POS resuelve la terminal desde esa cookie.
 *
 * ── Revocación sin depender del navegador ───────────────────────────────────
 *
 * El secreto lleva la `deviceSecretVersion` de la terminal. Desactivarla o
 * re-enrolarla incrementa esa versión, y **todos los secretos anteriores dejan
 * de validar del lado del servidor**. No hace falta que el navegador borre
 * nada: una máquina robada queda afuera en el momento en que el admin la
 * revoca.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { CookieOptions } from "express";

/** Nombre de la cookie que transporta la credencial de dispositivo. */
export const TERMINAL_COOKIE = "club_terminal";

/** Vigencia de la credencial: larga, porque la máquina no se muda todos los días. */
const DEVICE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 180 días

/** Vida del token de enrolamiento: corta, porque se usa una sola vez y ya. */
export const ENROLLMENT_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutos

export const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/** Comparación en tiempo constante: comparar con `===` filtra información. */
export const hashesMatch = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

/** Token de enrolamiento legible para dictarlo por teléfono si hace falta. */
export const generateEnrollmentToken = (): string =>
  randomBytes(24).toString("base64url");

/** Secreto de dispositivo. Nunca se guarda en claro: sólo su hash. */
export const generateDeviceSecret = (): string => randomBytes(32).toString("base64url");

/**
 * Arma el valor de la cookie: `terminalId.version.secreto`.
 *
 * La versión viaja adentro para poder rechazar un secreto viejo sin consultar
 * nada más que la terminal.
 */
export const buildDeviceCookieValue = (
  terminalId: number,
  version: number,
  secret: string,
): string => `${terminalId}.${version}.${secret}`;

export type ParsedDeviceCookie = {
  terminalId: number;
  version: number;
  secret: string;
};

export const parseDeviceCookieValue = (raw: unknown): ParsedDeviceCookie | null => {
  if (typeof raw !== "string") return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;

  const terminalId = Number(parts[0]);
  const version = Number(parts[1]);
  const secret = parts[2];

  if (!Number.isInteger(terminalId) || terminalId <= 0) return null;
  if (!Number.isInteger(version) || version < 0) return null;
  if (!secret) return null;

  return { terminalId, version, secret };
};

/**
 * Opciones de la cookie, conscientes del despliegue REAL.
 *
 * ⚠️ Topología verificada, no supuesta: `app.ts` documenta y configura una API
 * consumida por una SPA **cross-origin** (Vercel → Render), con
 * `cors({ credentials: true })`.
 *
 * Con `SameSite=Lax` la cookie NO viaja en ese escenario: el enrolamiento
 * andaría en local —donde todo es same-site— y fallaría en el mostrador. Es
 * exactamente la trampa que ya existe en `user.controller.ts`, donde el cookie
 * de sesión cae en `"lax"` por defecto mientras el de CSRF cae en `"none"`.
 * Acá el caso de producción es explícito.
 *
 * `SameSite=None` quita esa capa de defensa contra CSRF, así que la protección
 * real sigue siendo el doble envío ya implementado: esta cookie **no exime** de
 * validar el token CSRF en ninguna mutación.
 */
export const terminalCookieOptions = (): CookieOptions => {
  const isProduction = process.env.NODE_ENV === "production";
  const sameSite =
    (process.env.COOKIE_SAME_SITE as "none" | "lax" | "strict" | undefined) ??
    (isProduction ? "none" : "lax");

  return {
    // El secreto NUNCA es accesible por JavaScript. No va a localStorage, ni a
    // sessionStorage, ni a IndexedDB.
    httpOnly: true,
    // Obligatorio con SameSite=None; el navegador rechaza la cookie sin esto.
    secure: isProduction || sameSite === "none",
    sameSite,
    // Acota la superficie: sólo se manda a la API.
    path: "/api",
    maxAge: DEVICE_MAX_AGE_MS,
  };
};

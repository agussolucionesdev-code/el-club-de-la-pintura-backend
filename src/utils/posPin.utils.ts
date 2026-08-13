/**
 * PIN del punto de venta: verificación y autorrevelado.
 *
 * ── Por qué NO alcanza con hashear ──────────────────────────────────────────
 *
 * Un PIN de 6 dígitos son 10⁶ combinaciones. Con un volcado de la base, bcrypt
 * las recorre en minutos. Por eso acá van dos cosas juntas:
 *
 *   · **Argon2id**, que es memory-hard: cada intento cuesta memoria además de
 *     CPU, y eso arruina el paralelismo de una GPU.
 *   · **Un pepper que vive FUERA de la base**. Sin él, el hash no se puede
 *     verificar aunque se tenga la fila entera. Filtrar la base no alcanza:
 *     hace falta también la variable de entorno del servidor.
 *
 * ── Los secretos están separados a propósito ────────────────────────────────
 *
 *   POS_PIN_PEPPER   → verificar         (Argon2id)
 *   POS_PIN_ENC_KEY  → autorrevelado     (AES-256-GCM)
 *
 * Compartirlos anularía el beneficio de tener dos: una sola filtración daría
 * verificación **y** revelado a la vez.
 *
 * ── El riesgo que el negocio aceptó a conciencia ────────────────────────────
 *
 * Que cada persona pueda ver su propio PIN obliga a guardar una forma
 * REVERSIBLE del secreto. Quien obtenga la clave AES **y** un volcado de la
 * base recupera todos los PIN. Se mitiga con: clave fuera de la base, separada
 * del pepper, versionada para poder rotar, y rate limit con bloqueo. Pero el
 * riesgo residual existe y es consecuencia directa de esa decisión.
 *
 * ── La validación rutinaria NUNCA descifra ──────────────────────────────────
 *
 * Entrar al POS usa el hash. El descifrado existe sólo para el autorrevelado,
 * que además exige reautenticación con contraseña.
 */

import { Algorithm, hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";

/** Un PIN es exactamente 6 dígitos. Ni más corto, ni alfanumérico. */
export const PIN_PATTERN = /^\d{6}$/u;

/**
 * Parámetros de Argon2id.
 *
 * 19 MiB y 2 pasadas es la línea base que recomienda OWASP para Argon2id.
 * Deliberadamente moderado: la API corre en un plan chico y una validación de
 * PIN ocurre en el mostrador, con alguien esperando. Sube el costo del ataque
 * varios órdenes de magnitud sin agregar demora perceptible al cajero.
 */
const ARGON_OPTS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
} as const;

export class PinConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinConfigError";
  }
}

/** El pepper: obligatorio para verificar. Sin él no se puede ni entrar. */
const pepper = (): Buffer => {
  const raw = process.env.POS_PIN_PEPPER?.trim();
  if (!raw || raw.length < 16) {
    throw new PinConfigError(
      "Falta POS_PIN_PEPPER (mínimo 16 caracteres). Sin el pepper no se puede validar ningún PIN.",
    );
  }
  return Buffer.from(raw, "utf8");
};

/**
 * La clave de cifrado: sólo hace falta para el AUTORREVELADO.
 *
 * Devuelve `null` en vez de lanzar cuando no está, para que el sistema pueda
 * entrar en modo degradado: se sigue pudiendo VALIDAR el PIN (que usa el hash)
 * y se deshabilita revelar, crear y cambiar. Fallar cerrado también en la
 * validación dejaría el mostrador sin vender por una variable mal cargada.
 */
export const encryptionKey = (): Buffer | null => {
  const raw = process.env.POS_PIN_ENC_KEY?.trim();
  if (!raw) return null;

  // 32 bytes exactos para AES-256. Se acepta hex o base64.
  const buf = /^[0-9a-f]{64}$/iu.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");

  return buf.length === 32 ? buf : null;
};

/** ¿El autorrevelado está operativo? Si no, el sistema va en modo degradado. */
export const isRevealAvailable = (): boolean => encryptionKey() !== null;

/** Versión de la clave, para poder rotar sin invalidar lo ya cifrado. */
export const currentKeyVersion = (): number =>
  Number(process.env.POS_PIN_ENC_KEY_VERSION ?? 1);

// ── Verificación ───────────────────────────────────────────────────────────

export const hashPin = async (pin: string): Promise<string> => {
  if (!PIN_PATTERN.test(pin)) {
    throw new PinConfigError("El PIN debe tener exactamente 6 dígitos.");
  }
  return argonHash(pin, { ...ARGON_OPTS, secret: pepper() });
};

/**
 * Verifica un PIN contra su hash. **No descifra nada.**
 * Devuelve `false` ante cualquier fallo en vez de propagar: un error de
 * verificación no debe distinguirse de un PIN incorrecto.
 */
export const verifyPin = async (storedHash: string, pin: string): Promise<boolean> => {
  try {
    return await argonVerify(storedHash, pin, { secret: pepper() });
  } catch {
    return false;
  }
};

// ── Autorrevelado ──────────────────────────────────────────────────────────

/**
 * Los tres pedazos van como `Uint8Array` y no como `Buffer` porque es lo que
 * espera una columna `Bytes` de Prisma 7. `Buffer` extiende `Uint8Array`, pero
 * su `ArrayBuffer` puede ser compartido y el tipo generado no lo acepta.
 * Convertir acá —en el borde— evita repartir casts por los controladores.
 */
export type EncryptedPin = {
  cipher: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  tag: Uint8Array<ArrayBuffer>;
  keyVersion: number;
};

/**
 * Copia a un `Uint8Array` con `ArrayBuffer` propio.
 *
 * El parámetro de tipo importa: Prisma exige `Uint8Array<ArrayBuffer>` y
 * rechaza `Uint8Array<ArrayBufferLike>`, porque este último podría estar
 * respaldado por un `SharedArrayBuffer`. La copia lo garantiza.
 */
const aBytes = (buf: Buffer): Uint8Array<ArrayBuffer> => new Uint8Array(buf);

/**
 * Cifra el PIN para que su dueño pueda verlo después.
 *
 * AES-256-GCM con **nonce aleatorio por cifrado**: reusar un nonce con la misma
 * clave rompe GCM por completo y filtra el texto plano.
 */
export const encryptPin = (pin: string): EncryptedPin => {
  const key = encryptionKey();
  if (!key) {
    throw new PinConfigError(
      "No se puede guardar el PIN para autorrevelado: falta o es inválida POS_PIN_ENC_KEY.",
    );
  }

  const nonce = randomBytes(12); // 96 bits, el tamaño recomendado para GCM
  const cipherIv = createCipheriv("aes-256-gcm", key, nonce);
  const cipher = Buffer.concat([cipherIv.update(pin, "utf8"), cipherIv.final()]);

  return {
    cipher: aBytes(cipher),
    nonce: aBytes(nonce),
    tag: aBytes(cipherIv.getAuthTag()),
    keyVersion: currentKeyVersion(),
  };
};

/**
 * Descifra el PIN propio. Sólo se llama tras reautenticar con contraseña.
 *
 * El tag de autenticación de GCM detecta cualquier manipulación del texto
 * cifrado: si alguien tocó la fila en la base, esto falla en vez de devolver
 * basura que podría parecer un PIN válido.
 */
export const decryptPin = (guardado: EncryptedPin): string => {
  const key = encryptionKey();
  if (!key) {
    throw new PinConfigError(
      "No se puede revelar el PIN: falta o es inválida POS_PIN_ENC_KEY.",
    );
  }
  if (guardado.keyVersion !== currentKeyVersion()) {
    throw new PinConfigError(
      `El PIN fue cifrado con la clave versión ${guardado.keyVersion} y la vigente es la ` +
        `${currentKeyVersion()}. Restablecé tu PIN para poder volver a verlo.`,
    );
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(guardado.nonce));
  decipher.setAuthTag(Buffer.from(guardado.tag));
  return Buffer.concat([
    decipher.update(Buffer.from(guardado.cipher)),
    decipher.final(),
  ]).toString("utf8");
};

// ── Generación ─────────────────────────────────────────────────────────────

/** PIN de 6 dígitos con CSPRNG. `Math.random()` sería adivinable. */
export const generatePin = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** Credencial de activación: NO es un PIN. Se canjea para definir el propio. */
export const generateActivationCode = (): string =>
  randomBytes(18).toString("base64url");

// ── Rate limit y bloqueo ───────────────────────────────────────────────────

/** Tras este número de fallos seguidos, la cuenta queda bloqueada un rato. */
export const MAX_PIN_ATTEMPTS = 5;
/** Duración del bloqueo. Frena la fuerza bruta sin dejar a nadie afuera. */
export const LOCKOUT_MS = 15 * 60 * 1000;

/**
 * Demora progresiva: 0s, 1s, 2s, 4s, 8s… topeada.
 *
 * Encarece un ataque automatizado mucho más que al humano que se equivocó una
 * vez. El tope evita que un error honesto deje a alguien esperando un minuto.
 */
export const delayForAttempt = (fallosPrevios: number): number => {
  if (fallosPrevios <= 0) return 0;
  return Math.min(2 ** (fallosPrevios - 1) * 1000, 8000);
};

export const isLockedOut = (lockedUntil: Date | null): boolean =>
  lockedUntil !== null && lockedUntil.getTime() > Date.now();

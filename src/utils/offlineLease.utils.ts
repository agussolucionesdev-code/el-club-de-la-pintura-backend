/**
 * Permiso offline: quién estaba autorizado a vender sin internet.
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 *
 * Cuando se corta internet el POS sigue vendiendo y guarda las ventas en el
 * navegador. Al sincronizar, el servidor recibe una venta que dice "me hizo
 * Ana, el martes a las 10:15, en la terminal 2" — y no tiene forma de verificar
 * nada de eso. Le cree al navegador. Desde la Fase 8 ese dato decide cuánta
 * comisión cobra una persona, así que dejó de ser una molestia contable.
 *
 * ── Qué prueba este permiso, y qué NO ───────────────────────────────────────
 *
 *   SÍ prueba: que el servidor autorizó a ESE operador, en ESA sesión, sobre
 *              ESA terminal y sucursal; que la sesión no fue revocada; y, con
 *              la secuencia, que no es una operación repetida.
 *
 *   NO prueba: CUÁNDO se creó la operación.
 *
 * Y no puede probarlo: el reloj de la máquina lo maneja quien está sentado ahí,
 * y el registro en el navegador se puede editar. Un permiso firmado es una
 * credencial, no un sello de tiempo.
 *
 * ── La regla, entonces ──────────────────────────────────────────────────────
 *
 * La única hora que nadie del otro lado puede tocar es la del servidor. Así que
 * lo que decide es la hora de LLEGADA, no lo que diga el cliente. El timestamp
 * del cliente se guarda como dato informativo y no define nada.
 *
 * ── Tres niveles, no dos ────────────────────────────────────────────────────
 *
 * "Llegó tarde" NO puede significar "se pierde". Una venta entra SIEMPRE: mueve
 * stock, factura y emite comprobante. Lo que la ventana gobierna es si se le
 * cree automáticamente la atribución, que es lo que alimenta las comisiones.
 */

import crypto from "crypto";

import { logger } from "../config/logger";

/**
 * Cuánto vale un permiso, en horas.
 *
 * Configurable porque el número correcto depende de cómo opera el negocio y no
 * de una verdad técnica. Doce horas cubren un turno largo con margen y se
 * renuevan en cada contacto con el servidor, así que en operación normal nunca
 * vencen: la ventana sólo corre con corte de internet CONTINUO mientras se
 * vende. Cerrar de noche no cuenta.
 */
export const leaseTtlHours = (): number => {
  const crudo = process.env["OFFLINE_LEASE_TTL_HOURS"];
  if (!crudo) return 12;
  const horas = Number(crudo);
  if (!Number.isFinite(horas) || horas <= 0 || horas > 168) {
    logger.warn(
      `[lease] OFFLINE_LEASE_TTL_HOURS="${crudo}" es inválido; se usan 12 horas.`,
    );
    return 12;
  }
  return horas;
};

/**
 * Clave de firma.
 *
 * Si hay `OFFLINE_LEASE_SECRET`, se usa ésa. Si no, se DERIVA de `JWT_SECRET`
 * con separación de dominio.
 *
 * ── Por qué la derivación es aceptable acá ──────────────────────────────────
 *
 * La regla de tener secretos separados existe para que filtrar uno no regale el
 * otro. Con esta derivación, filtrar `JWT_SECRET` permitiría falsificar un
 * permiso — pero quien tenga `JWT_SECRET` ya puede falsificar la sesión de
 * cualquiera, que es estrictamente peor. O sea que no agrega superficie.
 *
 * A cambio, evita que el despliegue quede bloqueado esperando que alguien cargue
 * otra variable más: un permiso que no se puede emitir deja el POS sin poder
 * vender offline, y eso sí es una pérdida real. Cuando se cargue la variable
 * dedicada, la derivación deja de usarse sin tocar código.
 *
 * La etiqueta de dominio garantiza que una firma de permiso nunca pueda pasar
 * por otra cosa firmada con la misma base.
 */
const claveDeFirma = (): Buffer => {
  const dedicada = process.env["OFFLINE_LEASE_SECRET"];
  if (dedicada) return Buffer.from(dedicada, "utf8");

  const base = process.env["JWT_SECRET"];
  if (!base) {
    throw new Error(
      "No hay ni OFFLINE_LEASE_SECRET ni JWT_SECRET: no se puede firmar un permiso offline.",
    );
  }
  return crypto.createHmac("sha256", base).update("offline-lease:v1").digest();
};

export type OperationClass =
  | "SALE"
  | "EXPENSE"
  | "STOCK_ADJUST"
  | "CUSTOMER_CREATE"
  | "ACCOUNT_PAYMENT";

export const DEFAULT_OPERATION_CLASSES: OperationClass[] = [
  "SALE",
  "EXPENSE",
  "STOCK_ADJUST",
  "CUSTOMER_CREATE",
  "ACCOUNT_PAYMENT",
];

/** El contenido del permiso. Claves cortas: viaja en cada operación encolada. */
export type LeasePayload = {
  /** terminalId */ t: number;
  /** branchId */ b: number;
  /** operatorUserId */ o: number;
  /** operatorSessionId */ s: number;
  /** issuedAt, epoch ms del SERVIDOR */ iat: number;
  /** expiresAt, epoch ms del SERVIDOR */ exp: number;
  /** clases de operación permitidas */ ops: OperationClass[];
  /** securityVersion de la terminal: sube al revocar */ sv: number;
  /** base del contador anti-replay */ seq: number;
};

const b64url = (buf: Buffer): string => buf.toString("base64url");

const firmar = (payloadB64: string): string =>
  b64url(crypto.createHmac("sha256", claveDeFirma()).update(payloadB64).digest());

/** Emite un permiso firmado. `ahora` se inyecta para poder testear. */
export const issueLease = (
  datos: Omit<LeasePayload, "iat" | "exp" | "ops"> & { ops?: OperationClass[] },
  ahora: Date = new Date(),
): { token: string; payload: LeasePayload } => {
  const iat = ahora.getTime();
  const payload: LeasePayload = {
    t: datos.t,
    b: datos.b,
    o: datos.o,
    s: datos.s,
    iat,
    exp: iat + leaseTtlHours() * 3_600_000,
    ops: datos.ops ?? DEFAULT_OPERATION_CLASSES,
    sv: datos.sv,
    seq: datos.seq,
  };

  const cuerpo = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return { token: `${cuerpo}.${firmar(cuerpo)}`, payload };
};

export type LeaseVerification =
  | { ok: true; payload: LeasePayload }
  | { ok: false; reason: "MALFORMED" | "BAD_SIGNATURE" };

/**
 * Verifica la firma y devuelve el contenido. **No** juzga vencimiento acá: eso
 * es política y se decide en `decideAcceptance`, con la hora de llegada.
 */
export const verifyLease = (token: string): LeaseVerification => {
  if (typeof token !== "string" || !token.includes(".")) {
    return { ok: false, reason: "MALFORMED" };
  }

  const [cuerpo, firma] = token.split(".");
  if (!cuerpo || !firma) return { ok: false, reason: "MALFORMED" };

  const esperada = firmar(cuerpo);
  // Comparación en tiempo constante: comparar con `===` filtra por cuánto tarda
  // en fallar, y eso permite adivinar la firma byte por byte.
  const a = Buffer.from(firma);
  const b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  try {
    const payload = JSON.parse(
      Buffer.from(cuerpo, "base64url").toString("utf8"),
    ) as LeasePayload;

    // La firma ya garantiza que no lo tocaron, pero un permiso viejo de otra
    // versión podría no tener todos los campos y romper más abajo.
    if (
      typeof payload.t !== "number" ||
      typeof payload.exp !== "number" ||
      typeof payload.sv !== "number" ||
      !Array.isArray(payload.ops)
    ) {
      return { ok: false, reason: "MALFORMED" };
    }
    return { ok: true, payload };
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
};

/**
 * Los tres destinos posibles de una operación que llega de la cola offline.
 *
 * `TRUSTED`             entra sola, con atribución plena. Cuenta para comisión.
 * `NEEDS_CONFIRMATION`  ENTRA IGUAL —stock, facturación, comprobante— pero la
 *                       atribución queda marcada como no verificada y la
 *                       comisión espera que alguien con autoridad confirme.
 *                       No es un error: es una venta real que llegó tarde.
 * `REJECTED`            algo no cierra criptográficamente. Se frena y se revisa.
 */
export type AcceptanceTier = "TRUSTED" | "NEEDS_CONFIRMATION" | "REJECTED";

export type AcceptanceReason =
  | "OK"
  | "LATE_ARRIVAL"
  | "NO_LEASE"
  | "BAD_SIGNATURE"
  | "MALFORMED"
  | "SESSION_REVOKED"
  | "OPERATION_NOT_ALLOWED"
  | "REPLAY";

export type AcceptanceInput = {
  /** El permiso adjunto. `null` para las encoladas antes de que esto existiera. */
  token: string | null;
  /** Hora en que la operación LLEGÓ al servidor. La única confiable. */
  arrivedAt: Date;
  /** `deviceSecretVersion` actual de la terminal. */
  currentSecurityVersion: number;
  operationClass: OperationClass;
  /** Secuencia que declara la operación. */
  sequence: number;
  /** La última secuencia ya procesada de esa terminal. */
  lastSequenceSeen: number;
};

export type AcceptanceDecision = {
  tier: AcceptanceTier;
  reason: AcceptanceReason;
  payload: LeasePayload | null;
};

/**
 * Decide qué hacer con una operación sincronizada.
 *
 * El orden importa: primero lo que invalida la credencial por completo
 * (REJECTED), y recién al final el vencimiento, que sólo baja de nivel.
 */
export const decideAcceptance = (entrada: AcceptanceInput): AcceptanceDecision => {
  // Las operaciones encoladas ANTES de que existiera el permiso no tienen la
  // culpa de haberse encolado antes. Se procesan una vez, marcadas, y fuera de
  // incentivos: no se les inventa credibilidad, pero tampoco se tiran.
  if (!entrada.token) {
    return { tier: "NEEDS_CONFIRMATION", reason: "NO_LEASE", payload: null };
  }

  const verificado = verifyLease(entrada.token);
  if (!verificado.ok) {
    return { tier: "REJECTED", reason: verificado.reason, payload: null };
  }
  const lease = verificado.payload;

  // La terminal fue revocada o el PIN reseteado: el permiso quedó viejo. Esto
  // es lo que hace que dar de baja a alguien tenga efecto inmediato aunque su
  // máquina tenga operaciones encoladas.
  if (lease.sv !== entrada.currentSecurityVersion) {
    return { tier: "REJECTED", reason: "SESSION_REVOKED", payload: lease };
  }

  if (!lease.ops.includes(entrada.operationClass)) {
    return { tier: "REJECTED", reason: "OPERATION_NOT_ALLOWED", payload: lease };
  }

  // Repetición: una secuencia que ya se vio es un replay, no un reintento. Los
  // reintentos legítimos se resuelven por clave de idempotencia, que es otra
  // cosa y ya existe.
  if (entrada.sequence <= entrada.lastSequenceSeen) {
    return { tier: "REJECTED", reason: "REPLAY", payload: lease };
  }

  // Y acá la regla que ordena todo: la hora del SERVIDOR.
  if (entrada.arrivedAt.getTime() > lease.exp) {
    return { tier: "NEEDS_CONFIRMATION", reason: "LATE_ARRIVAL", payload: lease };
  }

  return { tier: "TRUSTED", reason: "OK", payload: lease };
};

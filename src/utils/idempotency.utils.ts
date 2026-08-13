/**
 * Idempotencia de operaciones económicas: exactamente una vez, aunque el
 * cliente reintente.
 *
 * ── El problema ─────────────────────────────────────────────────────────────
 *
 * `POST /sales` no tenía ninguna protección. Si la respuesta se perdía —timeout,
 * wifi del mostrador, el navegador que reintenta— el cliente volvía a mandar la
 * venta y el servidor creaba una segunda, con su propio descuento de stock y su
 * propio cobro. El cajero se enteraba al cerrar la caja.
 *
 * ── Por qué una clave sola no alcanza ───────────────────────────────────────
 *
 * Guardar "esta clave ya se usó" responde mal tres preguntas:
 *
 *   · ¿Es el MISMO pedido? → hace falta la huella del payload. Misma clave con
 *     otro contenido no es un reintento: es otra operación, y devolverle el
 *     resultado viejo sería contestarle otra pregunta.
 *   · ¿Es de QUIEN dice ser? → hace falta el alcance. Una clave de otra caja o
 *     de otra sucursal no puede cobrar el resultado ajeno.
 *   · ¿Quedó a medias? → hace falta un lease. Sin vencimiento, un proceso que
 *     muere deja la clave trabada para siempre.
 *
 * ── La parte difícil: el crash entre el commit y la respuesta ───────────────
 *
 * Si la transacción de negocio commitea pero el proceso muere antes de anotar
 * "listo", un reintento reejecutaría todo. La solución no es reconciliar
 * después: es que **no pueda pasar**. El `UPDATE` a COMPLETED va DENTRO de la
 * misma transacción que la venta, como última sentencia. Si commitea, quedó
 * anotado; si aborta, no quedó nada. Son un solo hecho atómico.
 *
 * ── Y la carrera del lease ──────────────────────────────────────────────────
 *
 * Queda un caso fino: el intento A arranca, tarda más que su lease, B lo toma
 * por vencido y ejecuta, y después A commitea igual. Dos efectos económicos.
 * Se cierra condicionando el cierre a `attemptId`: si A ya no es el dueño, su
 * `updateMany` afecta 0 filas, lanza, y **revierte toda su transacción**. Un
 * intento rancio no puede dejar rastro.
 */

import { createHash, randomUUID } from "node:crypto";

import { IdempotencyStatus, Prisma } from "@prisma/client";

import prisma, { type PrismaTx } from "../config/db";

/** Cuánto vale un lease. Holgado para una venta lenta, corto para no trabar. */
const LEASE_MS = 30_000;

/**
 * Alcance versión 1: el usuario autenticado y la sucursal.
 *
 * Todavía NO existe el modelo `Terminal` —llega en la Fase 3— y **no se fabrica
 * identidad de terminal a partir de datos del navegador**: sería confiar en el
 * cliente justo donde no se puede. Cuando `Terminal` y `PosOperatorSession`
 * existan, aparece la versión 2 y los registros v1 se siguen comparando con la
 * regla v1, sin migrar nada.
 */
export const SCOPE_VERSION_USER_BRANCH = 1;

export type IdempotencyScope = {
  version: number;
  parts: (string | number)[];
};

export const userBranchScope = (userId: number, branchId: number): IdempotencyScope => ({
  version: SCOPE_VERSION_USER_BRANCH,
  parts: ["user", userId, "branch", branchId],
});

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

/**
 * Serialización estable: ordena las claves de todo objeto anidado para que
 * `{a:1,b:2}` y `{b:2,a:1}` den la misma huella. Sin esto, el orden en que el
 * navegador arma el JSON decidiría si un reintento se reconoce o no.
 */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const inner = (value as Record<string, unknown>)[key];
        // `undefined` y las claves ausentes son lo mismo para el cliente:
        // se descartan para que no cambien la huella.
        if (inner !== undefined) acc[key] = canonicalize(inner);
        return acc;
      }, {});
  }
  return value;
};

export const fingerprintOf = (payload: unknown): string =>
  sha256(JSON.stringify(canonicalize(payload)));

const hashScope = (scope: IdempotencyScope): string =>
  sha256(`v${scope.version}:${scope.parts.join(":")}`);

/** Formato aceptado de clave. Acota longitud y evita basura inyectada. */
export const IDEMPOTENCY_KEY_PATTERN = /^[\w-]{8,120}$/u;

export type IdempotencyConflictCode =
  | "IDEMPOTENCY_PAYLOAD_MISMATCH"
  | "IDEMPOTENCY_SCOPE_MISMATCH"
  | "IDEMPOTENCY_IN_FLIGHT";

export type IdempotencyOutcome<T> =
  /** Se ejecutó de verdad, por primera vez. */
  | { kind: "executed"; value: T }
  /** Ya se había ejecutado: hay que devolver el mismo resultado. */
  | { kind: "replayed"; resultType: string; resultId: string; httpStatus: number }
  /** No se ejecuta: la clave no corresponde a este pedido. */
  | { kind: "conflict"; code: IdempotencyConflictCode; message: string };

export type ExecutionResult<T> = {
  value: T;
  resultType: string;
  resultId: string;
  httpStatus: number;
};

/** Perdimos la propiedad del lease mientras trabajábamos. Aborta todo. */
class OwnershipLostError extends Error {
  constructor(key: string) {
    super(`[IDEMPOTENCIA] Se perdió la propiedad del intento para la clave ${key}.`);
    this.name = "OwnershipLostError";
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/**
 * Intenta quedarse con el derecho a ejecutar la operación.
 * Devuelve `null` si lo consiguió, o el desenlace que corresponda si no.
 */
const claim = async (
  key: string,
  fingerprint: string,
  scope: IdempotencyScope,
  attemptId: string,
): Promise<IdempotencyOutcome<never> | null> => {
  const scopeHash = hashScope(scope);
  const lockedUntil = new Date(Date.now() + LEASE_MS);

  try {
    await prisma.idempotencyRecord.create({
      data: {
        key,
        fingerprint,
        scopeVersion: scope.version,
        scopeHash,
        status: IdempotencyStatus.IN_FLIGHT,
        attemptId,
        lockedUntil,
      },
    });
    return null; // clave nueva: es nuestra
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  const existing = await prisma.idempotencyRecord.findUnique({ where: { key } });
  if (!existing) {
    // Se borró entre el INSERT fallido y esta lectura. Cede el turno; el
    // cliente reintenta y arranca limpio.
    return {
      kind: "conflict",
      code: "IDEMPOTENCY_IN_FLIGHT",
      message: "La operación está siendo procesada. Reintentá en unos segundos.",
    };
  }

  // El contenido y el dueño se validan ANTES que el estado: una clave reusada
  // para otra cosa no es un reintento, sea cual sea el estado en que quedó.
  if (existing.fingerprint !== fingerprint) {
    return {
      kind: "conflict",
      code: "IDEMPOTENCY_PAYLOAD_MISMATCH",
      message:
        "La clave de idempotencia ya se usó para una operación con otro contenido. " +
        "Usá una clave nueva.",
    };
  }

  // Se compara con la regla de la versión ALMACENADA, no con la vigente: así un
  // registro v1 sigue siendo interpretable después de que exista la v2.
  if (existing.scopeVersion !== scope.version || existing.scopeHash !== scopeHash) {
    return {
      kind: "conflict",
      code: "IDEMPOTENCY_SCOPE_MISMATCH",
      message:
        "La clave de idempotencia pertenece a otro usuario o sucursal. " +
        "No se puede reutilizar acá.",
    };
  }

  if (existing.status === IdempotencyStatus.COMPLETED) {
    return {
      kind: "replayed",
      resultType: existing.resultType ?? "unknown",
      resultId: existing.resultId ?? "",
      httpStatus: existing.httpStatus ?? 200,
    };
  }

  // IN_FLIGHT con lease vigente: NO se le quita. La transacción original todavía
  // puede committear, y arrancar una segunda en paralelo es justo el duplicado
  // que estamos evitando.
  const leaseVigente =
    existing.status === IdempotencyStatus.IN_FLIGHT &&
    existing.lockedUntil !== null &&
    existing.lockedUntil.getTime() > Date.now();

  if (leaseVigente) {
    return {
      kind: "conflict",
      code: "IDEMPOTENCY_IN_FLIGHT",
      message: "La operación está siendo procesada. Reintentá en unos segundos.",
    };
  }

  // Lease vencido (el proceso murió) o intento anterior FALLIDO: se puede tomar.
  // El `where` incluye el attemptId viejo, así que si dos reintentos compiten
  // por el mismo registro rancio, sólo uno se lo lleva.
  const taken = await prisma.idempotencyRecord.updateMany({
    where: { key, attemptId: existing.attemptId, status: existing.status },
    data: {
      attemptId,
      status: IdempotencyStatus.IN_FLIGHT,
      lockedUntil: new Date(Date.now() + LEASE_MS),
      failureCode: null,
    },
  });

  if (taken.count !== 1) {
    return {
      kind: "conflict",
      code: "IDEMPOTENCY_IN_FLIGHT",
      message: "La operación está siendo procesada. Reintentá en unos segundos.",
    };
  }

  return null;
};

/**
 * Corre `run` bajo protección de idempotencia.
 *
 * `run` recibe el cliente transaccional y DEBE hacer todo su trabajo con él:
 * el cierre del registro va en esa misma transacción, así que si el trabajo se
 * revierte, la marca de "completado" se revierte con él.
 */
export const withIdempotency = async <T>(
  params: {
    key: string;
    payload: unknown;
    scope: IdempotencyScope;
    /** Sólo para tests: acorta el lease y permite provocar la carrera. */
    leaseMsOverride?: number;
  },
  run: (tx: PrismaTx) => Promise<ExecutionResult<T>>,
): Promise<IdempotencyOutcome<T>> => {
  const { key, payload, scope } = params;
  const fingerprint = fingerprintOf(payload);
  const attemptId = randomUUID();

  const blocked = await claim(key, fingerprint, scope, attemptId);
  if (blocked) return blocked as IdempotencyOutcome<T>;

  try {
    const executed = await prisma.$transaction(async (tx) => {
      const result = await run(tx);

      // ÚLTIMA sentencia de la transacción, y condicionada al attemptId.
      // Si perdimos la propiedad mientras trabajábamos, esto afecta 0 filas y
      // el throw revierte la venta, el stock, los pagos y el comprobante junto
      // con la marca. O somos dueños al cerrar, o no pasó nada.
      const owned = await tx.idempotencyRecord.updateMany({
        where: { key, attemptId, status: IdempotencyStatus.IN_FLIGHT },
        data: {
          status: IdempotencyStatus.COMPLETED,
          resultType: result.resultType,
          resultId: result.resultId,
          httpStatus: result.httpStatus,
          completedAt: new Date(),
          lockedUntil: null,
        },
      });

      if (owned.count !== 1) throw new OwnershipLostError(key);

      return result;
    });

    return { kind: "executed", value: executed.value };
  } catch (error) {
    // El fallo se anota en una transacción APARTE, ya abortada la de negocio.
    // Si se anotara adentro se iría con el rollback y la clave quedaría trabada.
    await prisma.idempotencyRecord
      .updateMany({
        where: { key, attemptId },
        data: {
          status: IdempotencyStatus.FAILED,
          lockedUntil: null,
          failureCode: error instanceof Error ? error.name : "UNKNOWN",
        },
      })
      .catch(() => {
        /* anotar el fallo nunca puede tapar el error real */
      });

    if (error instanceof OwnershipLostError) {
      return {
        kind: "conflict",
        code: "IDEMPOTENCY_IN_FLIGHT",
        message: "La operación fue tomada por otro intento. Reintentá en unos segundos.",
      };
    }

    throw error;
  }
};

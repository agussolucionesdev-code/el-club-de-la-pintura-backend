/**
 * El principal EFECTIVO del punto de venta.
 *
 * ── El problema que resuelve ────────────────────────────────────────────────
 *
 * La cookie de sesión dice quién abrió el navegador. En un mostrador
 * compartido, eso no es lo mismo que quién está vendiendo: la sesión puede
 * haberla iniciado el dueño a la mañana y estar atendiendo un empleado a la
 * tarde. Si autorizamos por el token, el empleado hereda los permisos del
 * dueño — y de paso las ventas se le atribuyen a quien no las hizo, lo que
 * ensucia la comisión y el arqueo.
 *
 * Acá se resuelven DOS identidades, explícitamente separadas:
 *
 *   · `authenticatedActor` — el dueño del JWT. Sólo para auditoría: nadie se
 *     esconde detrás del PIN de otro.
 *   · `effectiveUser`      — quien está operando la terminal ahora. **De acá
 *     salen las capacidades y la atribución.**
 *
 * Toda operación del POS autoriza con `effectiveCapabilities`. Jamás con el rol
 * del token.
 */

import { NextFunction, Response } from "express";

import prisma from "../config/db";
import { AuthRequest, getAuthUser } from "../middlewares/auth.middleware";
import { Capability, posCapabilitiesForRole, toCapabilityList } from "./capabilities";

/** Sin actividad por este tiempo, la sesión se considera abandonada. */
export const SESSION_IDLE_MS = 8 * 60 * 60 * 1000; // un turno largo, con margen

/**
 * Cada cuánto se refresca `lastActivityAt`.
 *
 * Escribirlo en cada request sería un UPDATE por venta consultada. Con un
 * minuto de granularidad alcanza de sobra para decidir si una sesión quedó
 * abandonada, y el mostrador no paga el costo.
 */
const ACTIVITY_THROTTLE_MS = 60 * 1000;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Quién opera esta terminal AHORA. Lo pone `requirePosContext`. */
      posContext?: PosRequestContext;
    }
  }
}

export type PosRequestContext = {
  terminal: { id: number; code: string; branchId: number };
  branchId: number;
  operatorSession: {
    id: number;
    origin: "PIN" | "LEGACY_JWT";
    startedAt: Date;
  };
  effectiveUser: { id: number; role: string; name: string };
  effectiveCapabilities: Set<Capability>;
  authenticatedActor: { id: number; role: string };
};

export type PosContextFailure =
  | "NO_TERMINAL" // esta computadora no está enrolada
  | "NO_OPERATOR_SESSION" // nadie identificado en la caja
  | "SESSION_EXPIRED"; // había alguien, pero hace rato

export class PosContextError extends Error {
  constructor(
    readonly code: PosContextFailure,
    message: string,
  ) {
    super(message);
    this.name = "PosContextError";
  }
}

/** ¿Sigue habilitada la sesión legado para quien todavía no configuró su PIN? */
export const isLegacySessionEnabled = (): boolean =>
  process.env.POS_LEGACY_SESSION_ENABLED !== "false";

/**
 * Resuelve el contexto de POS del request, o explica por qué no puede.
 *
 * Devuelve `null` en vez de lanzar cuando no hay contexto: quien llama decide
 * si eso es un error duro (una mutación) o simplemente información (una
 * pantalla que muestra "identificate para vender").
 */
export const resolvePosContext = async (
  req: AuthRequest,
): Promise<PosRequestContext | PosContextError> => {
  const authUser = getAuthUser(req);
  if (!authUser) {
    return new PosContextError("NO_OPERATOR_SESSION", "Sesión inválida.");
  }

  const terminal = req.terminal;
  if (!terminal) {
    return new PosContextError(
      "NO_TERMINAL",
      "Esta computadora no está enrolada como terminal. " +
        "Pedile a un administrador el token de enrolamiento desde Configuración → Terminales.",
    );
  }

  const sesion = await prisma.posOperatorSession.findFirst({
    where: { terminalId: terminal.id, status: "ACTIVE" },
    include: { user: { select: { id: true, name: true, role: true } } },
  });

  if (sesion) {
    // Sesión vencida por inactividad: se cierra y se pide identificación de
    // nuevo. Se cierra ACÁ y no por un job: si nadie vuelve a esa terminal, la
    // sesión vieja no molesta a nadie; si alguien vuelve, se limpia en el acto.
    if (Date.now() - sesion.lastActivityAt.getTime() > SESSION_IDLE_MS) {
      await prisma.posOperatorSession.update({
        where: { id: sesion.id },
        data: { status: "CLOSED", endedAt: new Date() },
      });
      return new PosContextError(
        "SESSION_EXPIRED",
        "La sesión de la caja venció por inactividad. Volvé a identificarte con tu PIN.",
      );
    }

    await touchSession(sesion.id, sesion.lastActivityAt);

    return buildContext({
      terminal,
      sesion: { id: sesion.id, origin: sesion.origin, startedAt: sesion.startedAt },
      operador: sesion.user,
      authUser,
    });
  }

  // ── Sin sesión: ¿corresponde la de transición? ──
  //
  // Quien todavía no configuró su PIN igual necesita vender. NO es un bypass:
  // se crea una sesión REAL, con capacidades resueltas y auditoría, marcada
  // LEGACY_JWT para que el historial diga la verdad. Y recibe las capacidades
  // de SU PROPIO rol — acá el operador y el dueño del token son la misma
  // persona por construcción, así que no hay nada que heredar de nadie.
  if (!isLegacySessionEnabled()) {
    return new PosContextError(
      "NO_OPERATOR_SESSION",
      "Identificate con tu PIN para operar esta caja.",
    );
  }

  const tienePin = await prisma.posPinCredential.findUnique({
    where: { userId: authUser.id },
    select: { isEnabled: true },
  });

  if (tienePin?.isEnabled) {
    // Tiene PIN y está habilitado: que lo use. Dejarlo entrar sin PIN sería
    // exactamente el bypass que este modelo viene a eliminar.
    return new PosContextError(
      "NO_OPERATOR_SESSION",
      "Identificate con tu PIN para operar esta caja.",
    );
  }

  const usuario = await prisma.user.findUnique({
    where: { id: authUser.id },
    select: { id: true, name: true, role: true },
  });

  if (!usuario) {
    return new PosContextError("NO_OPERATOR_SESSION", "Tu usuario ya no existe.");
  }

  const nueva = await prisma.posOperatorSession.create({
    data: {
      userId: usuario.id,
      terminalId: terminal.id,
      branchId: terminal.branchId,
      origin: "LEGACY_JWT",
      authenticatedActorId: authUser.id,
    },
    select: { id: true, origin: true, startedAt: true },
  });

  return buildContext({ terminal, sesion: nueva, operador: usuario, authUser });
};

const buildContext = ({
  terminal,
  sesion,
  operador,
  authUser,
}: {
  terminal: { id: number; code: string; branchId: number };
  sesion: { id: number; origin: "PIN" | "LEGACY_JWT"; startedAt: Date };
  operador: { id: number; name: string; role: string };
  authUser: { id: number; role: string };
}): PosRequestContext => ({
  terminal,
  // La sucursal SIEMPRE sale de la terminal, nunca del cuerpo del request:
  // la computadora está donde está, y eso no se declara, se prueba.
  branchId: terminal.branchId,
  operatorSession: sesion,
  effectiveUser: { id: operador.id, role: operador.role, name: operador.name },
  effectiveCapabilities: posCapabilitiesForRole(operador.role),
  authenticatedActor: { id: authUser.id, role: authUser.role },
});

const touchSession = async (id: number, lastActivityAt: Date) => {
  if (Date.now() - lastActivityAt.getTime() < ACTIVITY_THROTTLE_MS) return;
  try {
    await prisma.posOperatorSession.update({
      where: { id },
      data: { lastActivityAt: new Date() },
    });
  } catch {
    // Marcar actividad es contabilidad de sesión, no de negocio: si falla, la
    // venta tiene que seguir. Lo peor que pasa es que la sesión venza antes.
  }
};

/** Forma pública del contexto: lo que el POS necesita mostrar en pantalla. */
export const publicPosContext = (ctx: PosRequestContext) => ({
  terminal: { id: ctx.terminal.id, code: ctx.terminal.code, branchId: ctx.terminal.branchId },
  branchId: ctx.branchId,
  operator: {
    id: ctx.effectiveUser.id,
    name: ctx.effectiveUser.name,
    role: ctx.effectiveUser.role,
  },
  session: {
    id: ctx.operatorSession.id,
    origin: ctx.operatorSession.origin,
    startedAt: ctx.operatorSession.startedAt,
  },
  capabilities: toCapabilityList(ctx.effectiveCapabilities),
  // Cuando el operador NO es el dueño del token, el POS lo muestra en pantalla:
  // "sesión de X, opera Y". Que quede a la vista es parte de la garantía.
  authenticatedActor:
    ctx.authenticatedActor.id === ctx.effectiveUser.id
      ? null
      : { id: ctx.authenticatedActor.id },
});

/**
 * Exige un contexto de POS válido. Sin él, ninguna mutación del POS procede.
 *
 * El 401 lleva un código propio para que el frontend abra el diálogo de PIN
 * **sin recargar ni perder el borrador**: perder un carrito armado porque venció
 * una sesión sería castigar al cajero por un detalle técnico.
 */
export const requirePosContext = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const ctx = await resolvePosContext(req);

  if (ctx instanceof PosContextError) {
    const status = ctx.code === "NO_TERMINAL" ? 428 : 401;
    return res.status(status).json({ error: ctx.message, code: ctx.code });
  }

  req.posContext = ctx;
  next();
};

/** Exige una capacidad concreta del OPERADOR ACTIVO, no del dueño del token. */
export const requireCapability =
  (capability: Capability) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    const ctx = req.posContext;
    if (!ctx) {
      return res.status(401).json({
        error: "Identificate con tu PIN para operar esta caja.",
        code: "NO_OPERATOR_SESSION",
      });
    }
    if (!ctx.effectiveCapabilities.has(capability)) {
      return res.status(403).json({
        error: `${ctx.effectiveUser.name} no tiene permiso para esta acción.`,
        code: "CAPABILITY_DENIED",
      });
    }
    next();
  };

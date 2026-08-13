/**
 * Sesión de operador: quién está atendiendo esta caja, ahora.
 *
 * ── Lo que esto viene a reemplazar ──────────────────────────────────────────
 *
 * Hasta hoy, cambiar de vendedor significaba cerrar sesión y volver a entrar.
 * Y como el carrito vive en memoria, cerrar sesión **destruía el ticket a medio
 * armar**. En la práctica nadie cambiaba: el primero que abría el navegador a
 * la mañana quedaba como autor de todas las ventas del día. Toda la atribución
 * —y por lo tanto la comisión— era ficción.
 *
 * Con esto, entrar es un PIN de seis dígitos: el borrador de cada uno queda
 * guardado y se restaura al volver.
 *
 * ── Por qué se elige el perfil ANTES de tipear el PIN ───────────────────────
 *
 * Porque el PIN no es un identificador. Si lo fuera, dos personas con el mismo
 * PIN colisionarían, y probar 000000 loguearía como cualquiera que lo tenga.
 * Primero se dice quién sos, después se prueba.
 */

import { Response } from "express";

import prisma from "../../config/db";
import { logger } from "../../config/logger";
import {
  PosContextError,
  publicPosContext,
  resolvePosContext,
} from "../../core/pos-context";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import {
  delayForAttempt,
  isLockedOut,
  LOCKOUT_MS,
  MAX_PIN_ATTEMPTS,
  verifyPin,
} from "../../utils/posPin.utils";

const esperar = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * GET /pos/terminal/operators
 *
 * Quiénes pueden atender ESTA caja. La lista sale de la sucursal de la
 * TERMINAL, no de la del usuario que abrió el navegador: la computadora está
 * donde está, y eso no se declara, se prueba con la credencial de dispositivo.
 */
export const listTerminalOperators = async (req: AuthRequest, res: Response) => {
  try {
    const terminal = req.terminal;
    if (!terminal) {
      return res.status(428).json({
        error: "Esta computadora no está enrolada como terminal.",
        code: "TERMINAL_NOT_ENROLLED",
      });
    }

    const usuarios = await prisma.user.findMany({
      // `branches` es una relación implícita M:N contra Branch, así que el
      // filtro va por el id de la sucursal, no por una columna intermedia.
      where: { branches: { some: { id: terminal.branchId, isActive: true } } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        role: true,
        avatarUrl: true,
        posPin: { select: { isEnabled: true, lockedUntil: true } },
      },
    });

    const sesionActual = await prisma.posOperatorSession.findFirst({
      where: { terminalId: terminal.id, status: "ACTIVE" },
      select: { userId: true },
    });

    res.json({
      data: usuarios.map((usuario) => ({
        id: usuario.id,
        name: usuario.name,
        role: usuario.role,
        avatarUrl: usuario.avatarUrl,
        // Se informa si tiene PIN para que la pantalla explique por qué alguien
        // no puede entrar todavía, en vez de dejarlo probando.
        hasPin: Boolean(usuario.posPin?.isEnabled),
        locked: isLockedOut(usuario.posPin?.lockedUntil ?? null),
        isCurrent: sesionActual?.userId === usuario.id,
      })),
      terminal: { id: terminal.id, code: terminal.code, branchId: terminal.branchId },
    });
  } catch (error) {
    logger.error("Error al listar operadores de la terminal:", error);
    res.status(500).json({ error: "No se pudieron obtener los operadores." });
  }
};

/**
 * POST /pos/operator-sessions
 *
 * Cambio de operador (F10). Cierra la sesión anterior de ESTA terminal y abre
 * la nueva, en una sola transacción — el índice único parcial de la base impone
 * que nunca haya dos activas a la vez.
 */
export const openOperatorSession = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const terminal = req.terminal;
    if (!terminal) {
      return res.status(428).json({
        error:
          "Esta computadora no está enrolada como terminal. " +
          "Pedile a un administrador el token de enrolamiento.",
        code: "TERMINAL_NOT_ENROLLED",
      });
    }

    const { userId, pin } = req.body as { userId: number; pin: string };

    const objetivo = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        role: true,
        branches: { select: { id: true } },
        posPin: true,
      },
    });

    // Respuesta deliberadamente igual para "no existe", "no trabaja acá" y "no
    // tiene PIN": la lista de operadores ya dice quién puede entrar, así que
    // acá distinguirlos sólo ayudaría a quien está probando.
    const rechazo = () =>
      res.status(401).json({ error: "PIN incorrecto.", code: "BAD_PIN" });

    if (!objetivo) return rechazo();
    if (!objetivo.branches.some((b) => b.id === terminal.branchId)) return rechazo();

    const credencial = objetivo.posPin;
    if (!credencial?.isEnabled) return rechazo();

    // ── Bloqueo temporal ──
    if (isLockedOut(credencial.lockedUntil)) {
      const minutos = Math.ceil(
        ((credencial.lockedUntil?.getTime() ?? 0) - Date.now()) / 60000,
      );
      return res.status(429).json({
        error:
          `Demasiados intentos fallidos. Probá de nuevo en ${minutos} ` +
          `${minutos === 1 ? "minuto" : "minutos"}, o pedile a un encargado que restablezca el PIN.`,
        code: "PIN_LOCKED",
        lockedUntil: credencial.lockedUntil,
      });
    }

    // ── Demora progresiva ANTES de verificar ──
    // Encarece muchísimo un ataque automatizado y casi nada al humano que se
    // equivocó una vez. Va antes de verificar para que el tiempo de respuesta
    // no delate si el PIN era correcto.
    await esperar(delayForAttempt(credencial.failedAttempts));

    const valido = await verifyPin(credencial.pinHash, pin);

    if (!valido) {
      const fallos = credencial.failedAttempts + 1;
      const bloquear = fallos >= MAX_PIN_ATTEMPTS;

      await prisma.posPinCredential.update({
        where: { userId: objetivo.id },
        data: {
          failedAttempts: fallos,
          lockedUntil: bloquear ? new Date(Date.now() + LOCKOUT_MS) : null,
        },
      });

      if (bloquear) {
        await prisma.auditLog
          .create({
            data: {
              actorUserId: authUser.id,
              branchId: terminal.branchId,
              action: "POS_PIN_LOCKED",
              entityType: "User",
              entityId: String(objetivo.id),
              // Cuántos intentos, nunca con qué se intentó.
              metadata: { attempts: fallos, terminalCode: terminal.code },
            },
          })
          .catch(() => undefined);
      }

      return rechazo();
    }

    // ── PIN correcto: se abre la sesión ──
    const resultado = await prisma.$transaction(async (tx) => {
      // La anterior se cierra sí o sí: el índice parcial de la base no admite
      // dos activas en la misma terminal, y además queremos el registro de
      // hasta cuándo estuvo cada uno.
      await tx.posOperatorSession.updateMany({
        where: { terminalId: terminal.id, status: "ACTIVE" },
        data: { status: "CLOSED", endedAt: new Date() },
      });

      await tx.posPinCredential.update({
        where: { userId: objetivo.id },
        data: { failedAttempts: 0, lockedUntil: null },
      });

      const sesion = await tx.posOperatorSession.create({
        data: {
          userId: objetivo.id,
          terminalId: terminal.id,
          branchId: terminal.branchId,
          origin: "PIN",
          // Queda registrado quién tenía la sesión de cuenta abierta. Nadie se
          // esconde detrás del PIN de otro.
          authenticatedActorId: authUser.id,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: terminal.branchId,
          action: "POS_OPERATOR_SESSION_OPENED",
          entityType: "PosOperatorSession",
          entityId: String(sesion.id),
          metadata: {
            operatorUserId: objetivo.id,
            operatorName: objetivo.name,
            terminalCode: terminal.code,
            // Cuando el operador no es el dueño del token, que se vea.
            onBehalfOfSessionOf: authUser.id === objetivo.id ? null : authUser.id,
          },
        },
      });

      return sesion;
    });

    const ctx = await resolvePosContext(req);
    if (ctx instanceof PosContextError) {
      // No debería pasar: la sesión se acaba de crear. Si pasa, se informa el
      // motivo real en vez de devolver un contexto a medias.
      logger.error(`Contexto de POS irresoluble tras abrir sesión ${resultado.id}.`);
      return res.status(500).json({ error: ctx.message });
    }

    res.status(201).json({
      message: `Hola ${objetivo.name}. Estás operando ${terminal.code}.`,
      data: publicPosContext(ctx),
    });
  } catch (error) {
    logger.error("Error al abrir sesión de operador:", error);
    res.status(500).json({ error: "No se pudo abrir la sesión de operador." });
  }
};

/**
 * GET /pos/operator-sessions/current
 *
 * Quién está operando esta terminal. Es lo que el POS muestra en pantalla, de
 * forma prominente y permanente: que se vea a nombre de quién se está
 * vendiendo es parte de la garantía, no un adorno.
 *
 * No falla cuando no hay nadie: devuelve el motivo, para que la pantalla sepa
 * si tiene que pedir PIN o mandar a enrolar la computadora.
 */
export const getCurrentOperatorSession = async (req: AuthRequest, res: Response) => {
  try {
    const ctx = await resolvePosContext(req);

    if (ctx instanceof PosContextError) {
      return res.json({ data: null, code: ctx.code, message: ctx.message });
    }

    res.json({ data: publicPosContext(ctx) });
  } catch (error) {
    logger.error("Error al resolver la sesión de operador:", error);
    res.status(500).json({ error: "No se pudo resolver la sesión de operador." });
  }
};

/**
 * POST /pos/operator-sessions/current/close
 *
 * Deja la caja sin operador. Se usa al irse: la próxima persona tiene que
 * identificarse en vez de heredar la sesión de quien se fue.
 *
 * **No cierra el turno de caja.** Son cosas distintas: el turno es la plata del
 * cajón y su arqueo; la sesión es quién está parado adelante. Mezclarlas
 * obligaría a arquear cada vez que alguien va al baño.
 */
export const closeCurrentOperatorSession = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const terminal = req.terminal;
    if (!terminal) {
      return res.status(428).json({
        error: "Esta computadora no está enrolada como terminal.",
        code: "TERMINAL_NOT_ENROLLED",
      });
    }

    const cerradas = await prisma.posOperatorSession.updateMany({
      where: { terminalId: terminal.id, status: "ACTIVE" },
      data: { status: "CLOSED", endedAt: new Date() },
    });

    if (cerradas.count === 0) {
      return res.json({ message: "No había ninguna sesión abierta en esta caja." });
    }

    await prisma.auditLog
      .create({
        data: {
          actorUserId: authUser.id,
          branchId: terminal.branchId,
          action: "POS_OPERATOR_SESSION_CLOSED",
          entityType: "Terminal",
          entityId: String(terminal.id),
          metadata: { terminalCode: terminal.code },
        },
      })
      .catch(() => undefined);

    res.json({ message: "La caja quedó sin operador. Identificate para seguir vendiendo." });
  } catch (error) {
    logger.error("Error al cerrar la sesión de operador:", error);
    res.status(500).json({ error: "No se pudo cerrar la sesión de operador." });
  }
};

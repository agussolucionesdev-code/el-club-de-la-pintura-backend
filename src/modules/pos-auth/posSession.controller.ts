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
import { readSettings } from "../settings/settings.controller";
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
import { issueLease } from "../../utils/offlineLease.utils";

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
      /**
       * Qué pasa con la sesión que estaba abierta.
       *
       * El índice parcial de la base no admite dos ACTIVAS en la misma
       * terminal, así que la anterior tiene que dejar de serlo. Pero adónde va
       * depende del modo de trabajo:
       *
       *   SESION_POR_USUARIO   se CIERRA. Cada quien en su computadora; que
       *     alguien más entre significa que el anterior terminó.
       *
       *   TERMINAL_COMPARTIDA  se BLOQUEA. Es una caja donde varios se
       *     alternan: el anterior sigue teniendo su pestaña y su carrito
       *     esperándolo. Cerrarla lo obligaría a empezar de cero cada vez que
       *     un compañero cobra algo, que es exactamente la fricción que este
       *     modo viene a sacar.
       *
       * En los dos casos la atribución sigue siendo inequívoca, porque activa
       * hay una sola.
       */
      const modo = (await readSettings()).posModoOperacion;
      await tx.posOperatorSession.updateMany({
        where: { terminalId: terminal.id, status: "ACTIVE" },
        data:
          modo === "TERMINAL_COMPARTIDA"
            ? { status: "LOCKED" }
            : { status: "CLOSED", endedAt: new Date() },
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

    // El permiso offline se entrega al abrir la sesión y se renueva en cada
    // contacto con el servidor. Es lo que le permite al POS seguir vendiendo
    // sin internet con una atribución que después se puede verificar.
    //
    // Si no se puede firmar —falta el secreto— NO se corta la sesión: se abre
    // igual y se avisa. Dejar la caja sin poder operar por una variable de
    // entorno sería una pérdida real; lo que se pierde acá es la atribución
    // verificable offline, que degrada pero no frena.
    let offlineLease: { token: string; expiresAt: Date } | null = null;
    try {
      // `req.terminal` es el contexto resuelto de la cookie y no trae estos dos
      // campos. Se leen de la fila para que el permiso quede atado a la versión
      // de seguridad VIGENTE: si alguien revocó la terminal hace un segundo, el
      // permiso nace ya inválido en vez de nacer bueno.
      const fila = await prisma.terminal.findUnique({
        where: { id: terminal.id },
        select: { deviceSecretVersion: true, lastOfflineSequence: true },
      });
      if (!fila) throw new Error(`La terminal ${terminal.id} desapareció.`);

      const emitido = issueLease({
        t: terminal.id,
        b: terminal.branchId,
        o: objetivo.id,
        s: resultado.id,
        sv: fila.deviceSecretVersion,
        seq: fila.lastOfflineSequence,
      });
      offlineLease = {
        token: emitido.token,
        expiresAt: new Date(emitido.payload.exp),
      };
    } catch (error) {
      logger.error(
        "[lease] No se pudo emitir el permiso offline; la sesión abre igual.",
        error,
      );
    }

    res.status(201).json({
      message: `Hola ${objetivo.name}. Estás operando ${terminal.code}.`,
      data: { ...publicPosContext(ctx), offlineLease },
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

/**
 * GET /pos/operator-sessions/open — las pestañas abiertas de esta caja.
 *
 * Devuelve la sesión ACTIVA y todas las BLOQUEADAS de la terminal. Cada una es
 * una pestaña: alguien que está vendiendo o que dejó su carrito a medio armar
 * y va a volver.
 *
 * Sólo tiene sentido en modo TERMINAL_COMPARTIDA. En el otro modo devuelve como
 * mucho la propia, porque no hay pestañas que mostrar.
 */
export const listOpenOperatorSessions = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const terminal = req.terminal;
    if (!terminal) {
      return res.status(428).json({
        error: "Esta computadora no está enrolada como terminal.",
        code: "TERMINAL_NOT_ENROLLED",
      });
    }

    const ajustes = await readSettings();

    const sesiones = await prisma.posOperatorSession.findMany({
      where: { terminalId: terminal.id, status: { in: ["ACTIVE", "LOCKED"] } },
      orderBy: { startedAt: "asc" },
      select: {
        id: true,
        status: true,
        startedAt: true,
        origin: true,
        user: { select: { id: true, name: true, role: true } },
      },
    });

    res.json({
      data: sesiones,
      /**
       * El modo viaja con la respuesta a propósito.
       *
       * La pantalla necesita saber si dibuja pestañas o no, y preguntárselo a
       * otro endpoint abriría una ventana donde una cosa dice A y la otra B.
       */
      modo: ajustes.posModoOperacion,
      exigePin: ajustes.posPinAlCambiarDePestana,
    });
  } catch (error) {
    logger.error("Error al listar las sesiones abiertas:", error);
    res.status(500).json({ error: "No se pudieron listar las pestañas." });
  }
};

/**
 * POST /pos/operator-sessions/:id/resume — volver a una pestaña.
 *
 * Bloquea la que estaba activa y activa la pedida. Nunca hay dos activas: la
 * base no lo admite y la atribución de cada venta depende de que no las haya.
 *
 * El PIN se exige o no según la configuración. Con `posPinAlCambiarDePestana`
 * encendido —el valor por defecto— volver a la pestaña de otro pide su código,
 * porque si no cualquiera que pase por la caja puede vender a su nombre.
 */
export const resumeOperatorSession = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const terminal = req.terminal;
    if (!terminal) {
      return res.status(428).json({
        error: "Esta computadora no está enrolada como terminal.",
        code: "TERMINAL_NOT_ENROLLED",
      });
    }

    const ajustes = await readSettings();
    if (ajustes.posModoOperacion !== "TERMINAL_COMPARTIDA") {
      return res.status(409).json({
        error:
          "Las pestañas por operador están apagadas. Se activan desde Configuración.",
        code: "MODO_NO_HABILITADO",
      });
    }

    const sesionId = Number(req.params.id);
    const objetivo = await prisma.posOperatorSession.findUnique({
      where: { id: sesionId },
      include: { user: { select: { id: true, name: true, role: true } } },
    });

    // Que la sesión sea DE ESTA terminal se verifica siempre: sin esto, mandar
    // un id de otra caja activaría una sesión ajena en esta computadora.
    if (!objetivo || objetivo.terminalId !== terminal.id) {
      return res.status(404).json({ error: "Esa pestaña no es de esta caja." });
    }
    if (objetivo.status === "CLOSED") {
      return res.status(409).json({
        error: "Esa pestaña ya se cerró. Identificate de nuevo para abrir otra.",
        code: "SESION_CERRADA",
      });
    }

    if (ajustes.posPinAlCambiarDePestana) {
      const pin = String((req.body ?? {}).pin ?? "");
      const credencial = await prisma.posPinCredential.findUnique({
        where: { userId: objetivo.userId },
      });
      if (!credencial || !(await verifyPin(credencial.pinHash, pin))) {
        return res.status(401).json({
          error: "Código incorrecto.",
          code: "BAD_PIN",
        });
      }
    }

    const sesion = await prisma.$transaction(async (tx) => {
      await tx.posOperatorSession.updateMany({
        where: { terminalId: terminal.id, status: "ACTIVE" },
        data: { status: "LOCKED" },
      });
      return tx.posOperatorSession.update({
        where: { id: objetivo.id },
        data: { status: "ACTIVE" },
        include: { user: { select: { id: true, name: true, role: true } } },
      });
    });

    await prisma.auditLog
      .create({
        data: {
          actorUserId: getAuthUser(req)?.id ?? 0,
          branchId: terminal.branchId,
          action: "POS_OPERATOR_SESSION_RESUMED",
          entityType: "PosOperatorSession",
          entityId: String(sesion.id),
          metadata: {
            terminalCode: terminal.code,
            operador: sesion.user.name,
            conPin: ajustes.posPinAlCambiarDePestana,
          },
        },
      })
      .catch(() => undefined);

    res.json({ message: `Volviste a la caja de ${sesion.user.name}.`, data: sesion });
  } catch (error) {
    logger.error("Error al volver a la pestaña:", error);
    res.status(500).json({ error: "No se pudo volver a esa pestaña." });
  }
};

/**
 * POST /pos/operator-sessions/:id/close — cerrar UNA pestaña.
 *
 * Distinto de cerrar la caja: acá se termina el turno de una persona y las
 * demás pestañas siguen abiertas.
 */
export const closeOneOperatorSession = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const terminal = req.terminal;
    if (!terminal) {
      return res.status(428).json({
        error: "Esta computadora no está enrolada como terminal.",
        code: "TERMINAL_NOT_ENROLLED",
      });
    }

    const sesionId = Number(req.params.id);
    const objetivo = await prisma.posOperatorSession.findUnique({
      where: { id: sesionId },
      include: { user: { select: { name: true } } },
    });
    if (!objetivo || objetivo.terminalId !== terminal.id) {
      return res.status(404).json({ error: "Esa pestaña no es de esta caja." });
    }

    await prisma.posOperatorSession.update({
      where: { id: objetivo.id },
      data: { status: "CLOSED", endedAt: new Date() },
    });

    await prisma.auditLog
      .create({
        data: {
          actorUserId: getAuthUser(req)?.id ?? 0,
          branchId: terminal.branchId,
          action: "POS_OPERATOR_SESSION_CLOSED",
          entityType: "PosOperatorSession",
          entityId: String(objetivo.id),
          metadata: { terminalCode: terminal.code, operador: objetivo.user.name },
        },
      })
      .catch(() => undefined);

    res.json({ message: `Se cerró la pestaña de ${objetivo.user.name}.` });
  } catch (error) {
    logger.error("Error al cerrar la pestaña:", error);
    res.status(500).json({ error: "No se pudo cerrar esa pestaña." });
  }
};

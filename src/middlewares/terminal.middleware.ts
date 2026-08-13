/**
 * Resuelve QUÉ TERMINAL es esta computadora, a partir de su credencial.
 *
 * Corre en todas las rutas: si la cookie es válida, deja la terminal en
 * `req.terminal`; si no, la deja en `null` y sigue. Nunca corta el request —
 * quien decide si una operación exige terminal es cada ruta.
 *
 * ── Por qué la terminal no puede venir del cuerpo ───────────────────────────
 *
 * Un `terminalId` en el body es una afirmación sin respaldo. Con incentivos por
 * vendedor de por medio, aceptarla significa que cualquiera con sesión válida
 * puede atribuirle sus ventas a otra caja. Acá la terminal se PRUEBA con un
 * secreto que emitió el servidor.
 */

import { NextFunction, Request, Response } from "express";

import prisma from "../config/db";
import { logger } from "../config/logger";
import {
  hashesMatch,
  parseDeviceCookieValue,
  sha256,
  TERMINAL_COOKIE,
} from "../utils/terminalDevice.utils";

export type ResolvedTerminal = {
  id: number;
  code: string;
  name: string;
  branchId: number;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Terminal probada por la credencial de dispositivo. `null` si no hay. */
      terminal?: ResolvedTerminal | null;
    }
  }
}

/** Cada cuánto se refresca `lastSeenAt`, para no escribir en cada request. */
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

export const resolveTerminalFromCookie = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  req.terminal = null;

  const parsed = parseDeviceCookieValue(req.cookies?.[TERMINAL_COOKIE]);
  if (!parsed) return next();

  try {
    const terminal = await prisma.terminal.findUnique({
      where: { id: parsed.terminalId },
      select: {
        id: true,
        code: true,
        name: true,
        branchId: true,
        status: true,
        deviceSecretHash: true,
        deviceSecretVersion: true,
        lastSeenAt: true,
      },
    });

    if (!terminal || !terminal.deviceSecretHash) return next();
    // Desactivada: la credencial deja de valer aunque siga siendo criptográficamente correcta.
    if (terminal.status !== "ACTIVE") return next();
    // Versión vieja: la terminal fue revocada o re-enrolada. Este es el mecanismo
    // que corta el acceso de una máquina perdida sin depender del navegador.
    if (terminal.deviceSecretVersion !== parsed.version) return next();
    // Comparación en tiempo constante.
    if (!hashesMatch(sha256(parsed.secret), terminal.deviceSecretHash)) return next();

    req.terminal = {
      id: terminal.id,
      code: terminal.code,
      name: terminal.name,
      branchId: terminal.branchId,
    };

    // Señal de vida, con throttle: sirve para que el dueño vea qué cajas están
    // realmente en uso, y no justifica una escritura por request.
    const vencido =
      !terminal.lastSeenAt ||
      Date.now() - terminal.lastSeenAt.getTime() > LAST_SEEN_REFRESH_MS;

    if (vencido) {
      prisma.terminal
        .update({ where: { id: terminal.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {
          /* una marca de actividad nunca puede tumbar una venta */
        });
    }
  } catch (error) {
    // Un fallo resolviendo la terminal no debe cortar el request: se sigue sin
    // terminal y la ruta que la exija responderá con su propio error claro.
    logger.error("[TERMINAL] No se pudo resolver la credencial de dispositivo:", error);
  }

  next();
};

/** Exige que la computadora esté enrolada. Para rutas de POS. */
export const requireEnrolledTerminal = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.terminal) {
    res.status(428).json({
      error:
        "Esta computadora no está enrolada como terminal de venta. " +
        "Pedile a un administrador que genere un token de enrolamiento.",
      code: "TERMINAL_NOT_ENROLLED",
    });
    return;
  }
  next();
};

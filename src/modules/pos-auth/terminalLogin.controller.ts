/**
 * Entrar al sistema con el código de seis dígitos, desde una terminal.
 *
 * ── Qué problema resuelve ───────────────────────────────────────────────────
 *
 * En el mostrador se alternan varias personas sobre la misma computadora.
 * Tipear un email largo y una contraseña cada vez que alguien se corre no es
 * sólo lento: cuando entrar cuesta caro, la gente deja de hacerlo y se ponen a
 * vender todos con la sesión del primero que llegó. Ahí se rompe la
 * atribución — y de la atribución dependen las comisiones. Un código corto por
 * persona es más rápido Y más honesto.
 *
 * ── Por qué esto NO es "login con PIN" ──────────────────────────────────────
 *
 * Un PIN de seis dígitos son 10⁶ combinaciones. Como credencial única contra
 * una API abierta a internet sería indefendible. Acá no lo es, porque son DOS
 * factores:
 *
 *   · algo que se TIENE — la credencial de dispositivo de una terminal
 *     enrolada, firmada por el servidor, HttpOnly, revocable por versión.
 *     Sin ella este endpoint no existe: responde 428 y no mira el PIN.
 *   · algo que se SABE — el código.
 *
 * Quien no esté físicamente en una de las dos cajas no puede ni empezar.
 *
 * ── Y lo que esta sesión NO habilita ────────────────────────────────────────
 *
 * El dueño también atiende, y su código abre una sesión con rol ADMIN. Por eso
 * el token queda marcado como `PIN` y `requireFullAuth` corta las acciones
 * administrativas. Seis dígitos tipeados sobre un mostrador, a la vista de
 * quien espera su turno, alcanzan para vender. No para borrar usuarios.
 */

import { Request, Response } from "express";

import prisma from "../../config/db";
import { logger } from "../../config/logger";
import {
  delayForAttempt,
  isLockedOut,
  LOCKOUT_MS,
  MAX_PIN_ATTEMPTS,
  verifyPin,
} from "../../utils/posPin.utils";
import { emitirSesion } from "../../utils/session.utils";

const esperar = (ms: number) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * GET /auth/terminal-access
 *
 * Quién puede entrar en ESTA computadora. Es lo primero que consulta la pantalla
 * de inicio de sesión: si la máquina no está enrolada, no ofrece el acceso por
 * código y muestra directamente el formulario de contraseña.
 *
 * No exige sesión —por definición todavía no hay ninguna— pero sí la credencial
 * de dispositivo. La lista de nombres sale de la sucursal de la TERMINAL, no de
 * una sucursal que el navegador declare.
 *
 * Responde 200 con `enrolled: false` en vez de un error cuando no hay terminal:
 * para la pantalla de login eso no es una falla, es el caso más común (la
 * computadora del escritorio del dueño no es una caja).
 */
export const getTerminalAccess = async (req: Request, res: Response) => {
  try {
    const terminal = req.terminal;
    if (!terminal) {
      return res.json({ enrolled: false, terminal: null, operators: [] });
    }

    const usuarios = await prisma.user.findMany({
      // El modelo User no tiene baja lógica: quien no debe entrar más se saca
      // de la sucursal o se le deshabilita el código. Las dos cosas cierran
      // esta puerta, y las dos ya existen en Configuración.
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

    res.json({
      enrolled: true,
      terminal: {
        id: terminal.id,
        code: terminal.code,
        name: terminal.name,
        branchId: terminal.branchId,
      },
      // Se listan TODOS los de la sucursal, con o sin código, y se informa
      // cuál es cuál. Esconder a quien todavía no lo configuró lo dejaría
      // buscándose en una lista donde no está, sin entender por qué.
      operators: usuarios.map((usuario) => ({
        id: usuario.id,
        name: usuario.name,
        role: usuario.role,
        avatarUrl: usuario.avatarUrl,
        hasPin: Boolean(usuario.posPin?.isEnabled),
        locked: isLockedOut(usuario.posPin?.lockedUntil ?? null),
      })),
    });
  } catch (error) {
    logger.error("[ACCESO] No se pudo listar el acceso de la terminal:", error);
    res.status(500).json({ error: "No se pudo consultar esta terminal." });
  }
};

/**
 * POST /auth/terminal-access/login
 *
 * Abre sesión con `{ userId, pin }` desde una terminal enrolada.
 *
 * El perfil se elige ANTES de tipear el código, y eso es deliberado: el PIN no
 * es un identificador. Si lo fuera, dos personas con el mismo código
 * colisionarían y probar 000000 entraría como cualquiera que lo tenga. Primero
 * se dice quién sos, después se prueba.
 */
export const loginWithTerminalPin = async (req: Request, res: Response) => {
  try {
    const terminal = req.terminal;
    if (!terminal) {
      return res.status(428).json({
        error:
          "Esta computadora no está enrolada como terminal. " +
          "Entrá con tu email y contraseña.",
        code: "TERMINAL_NOT_ENROLLED",
      });
    }

    const { userId, pin } = req.body as { userId: number; pin: string };

    const objetivo = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        avatarUrl: true,
        branches: { where: { isActive: true }, select: { id: true, name: true } },
        posPin: true,
      },
    });

    /**
     * Una sola respuesta para "no existe", "no trabaja en esta sucursal",
     * "no tiene código" y "el código está mal".
     *
     * Distinguirlos sólo le serviría a quien está probando: le diría qué ids
     * son usuarios reales y cuáles tienen código configurado. La pantalla ya
     * lista quién puede entrar acá, así que a la persona de verdad no le falta
     * ninguna información.
     */
    const rechazo = () =>
      res.status(401).json({ error: "Código incorrecto.", code: "BAD_PIN" });

    if (!objetivo) return rechazo();
    if (!objetivo.branches.some((sucursal) => sucursal.id === terminal.branchId)) {
      return rechazo();
    }

    const credencial = objetivo.posPin;
    if (!credencial?.isEnabled) return rechazo();

    // ── Bloqueo temporal ──
    // Vive en la credencial y es por USUARIO. El límite por origen que aplica
    // el router es la otra mitad: sin él, probar contra muchos usuarios
    // distintos desde la misma máquina saldría gratis.
    if (isLockedOut(credencial.lockedUntil)) {
      const minutos = Math.ceil(
        ((credencial.lockedUntil?.getTime() ?? 0) - Date.now()) / 60000,
      );
      return res.status(429).json({
        error:
          `Demasiados intentos fallidos. Probá en ${minutos} ` +
          `${minutos === 1 ? "minuto" : "minutos"}, o entrá con tu contraseña.`,
        code: "PIN_LOCKED",
        lockedUntil: credencial.lockedUntil,
      });
    }

    // ── Demora progresiva, ANTES de verificar ──
    // Va antes a propósito: si fuera después, el tiempo de respuesta delataría
    // si el código era correcto incluso cuando la respuesta dice lo mismo.
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
              // No hay actor autenticado: el intento fallido ES el anónimo.
              // Lo que identifica el hecho es la terminal y a quién se apuntaba.
              actorUserId: objetivo.id,
              branchId: terminal.branchId,
              action: "POS_PIN_LOCKED",
              entityType: "User",
              entityId: String(objetivo.id),
              // Cuántos intentos hubo. Nunca con qué se intentó.
              metadata: {
                attempts: fallos,
                terminalCode: terminal.code,
                origin: "TERMINAL_LOGIN",
              },
            },
          })
          .catch(() => undefined);
      }

      return rechazo();
    }

    // ── Código correcto ──
    await prisma.posPinCredential.update({
      where: { userId: objetivo.id },
      data: { failedAttempts: 0, lockedUntil: null },
    });

    const usuario = emitirSesion(
      req,
      res,
      {
        id: objetivo.id,
        name: objetivo.name,
        email: objetivo.email,
        role: objetivo.role,
        avatarUrl: objetivo.avatarUrl,
        branches: objetivo.branches,
      },
      "PIN",
    );

    await prisma.auditLog
      .create({
        data: {
          actorUserId: objetivo.id,
          branchId: terminal.branchId,
          action: "LOGIN_TERMINAL_PIN",
          entityType: "User",
          entityId: String(objetivo.id),
          metadata: { terminalCode: terminal.code, terminalId: terminal.id },
        },
      })
      .catch(() => {
        /* una marca de auditoría nunca puede impedir que alguien entre a vender */
      });

    res.status(200).json({ message: `Hola, ${objetivo.name}.`, user: usuario });
  } catch (error) {
    logger.error("[ACCESO] Fallo el ingreso con código de terminal:", error);
    res.status(500).json({ error: "No se pudo iniciar sesión." });
  }
};

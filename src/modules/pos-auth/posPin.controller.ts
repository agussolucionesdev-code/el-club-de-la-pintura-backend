/**
 * PIN del punto de venta: configurarlo, cambiarlo, verlo y restablecerlo.
 *
 * ── Las tres reglas que ordenan todo este archivo ───────────────────────────
 *
 * 1. **Nadie ve el PIN de otro.** No hay endpoint que lo devuelva, ni siquiera
 *    para el dueño. Un encargado que restablece un PIN ajeno recibe una
 *    CREDENCIAL DE ACTIVACIÓN, que no es un PIN: no sirve para entrar, sólo
 *    para que su dueño elija el suyo. Así el encargado nunca puede operar como
 *    esa persona, ni por un momento.
 *
 * 2. **Ver el PIN propio exige la contraseña.** Es la única operación que
 *    descifra algo, y por eso se paga con reautenticación fresca. El resto del
 *    sistema —entrar a la caja todos los días— usa el hash y nunca descifra.
 *
 * 3. **Se audita el HECHO, jamás el VALOR.** En el registro queda "Fulano vio
 *    su PIN a las 14:32". El PIN no aparece en la auditoría, ni en los logs, ni
 *    en un toast, ni en un reporte de error.
 */

import bcrypt from "bcrypt";
import { Response } from "express";

import prisma from "../../config/db";
import { logger } from "../../config/logger";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import {
  currentKeyVersion,
  decryptPin,
  encryptPin,
  generateActivationCode,
  hashPin,
  isRevealAvailable,
  PinConfigError,
} from "../../utils/posPin.utils";
import { sha256 } from "../../utils/terminalDevice.utils";

/** La credencial de activación vive poco: se canjea el mismo día o se pide otra. */
const ACTIVATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Verifica la contraseña de la cuenta.
 *
 * Devuelve el usuario o `null`. No distingue "no existe" de "contraseña
 * incorrecta": son la misma respuesta para quien está del otro lado.
 */
const reautenticar = async (userId: number, password: string) => {
  const usuario = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, password: true },
  });
  if (!usuario) return null;
  const ok = await bcrypt.compare(password, usuario.password);
  return ok ? usuario : null;
};

/** Cabeceras para una respuesta que NUNCA debe quedar guardada en ningún lado. */
const sinCache = (res: Response) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
};

/**
 * GET /me/pos-pin
 *
 * Estado del PIN propio. Nunca el PIN: ni cifrado, ni parcial, ni enmascarado
 * con la longitud real. Sólo si existe y desde cuándo.
 */
export const getMyPinStatus = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const credencial = await prisma.posPinCredential.findUnique({
      where: { userId: authUser.id },
      select: {
        isEnabled: true,
        mustChange: true,
        lastChangedAt: true,
        lastRevealAt: true,
        lockedUntil: true,
        pinCipher: true,
        keyVersion: true,
      },
    });

    const bloqueadoHasta =
      credencial?.lockedUntil && credencial.lockedUntil.getTime() > Date.now()
        ? credencial.lockedUntil
        : null;

    res.json({
      data: {
        configured: Boolean(credencial),
        enabled: credencial?.isEnabled ?? false,
        mustChange: credencial?.mustChange ?? false,
        lastChangedAt: credencial?.lastChangedAt ?? null,
        lastRevealAt: credencial?.lastRevealAt ?? null,
        lockedUntil: bloqueadoHasta,
        // Modo degradado: sin clave de cifrado se puede seguir VALIDANDO el PIN
        // (usa el hash), pero no verlo ni cambiarlo. Se informa para que la
        // pantalla explique por qué el botón está apagado en vez de fallar.
        degradedMode: !isRevealAvailable(),
        // Un PIN cifrado con una clave que ya se rotó no se puede mostrar más.
        // Se avisa acá para que la persona lo restablezca cuando quiera, y no
        // se entere justo cuando lo necesita.
        revealable:
          isRevealAvailable() &&
          Boolean(credencial?.pinCipher) &&
          credencial?.keyVersion === currentKeyVersion(),
      },
    });
  } catch (error) {
    logger.error("Error al consultar el estado del PIN:", error);
    res.status(500).json({ error: "No se pudo consultar el estado del PIN." });
  }
};

/**
 * PUT /me/pos-pin
 *
 * Define o cambia el PIN propio. Exige la contraseña de la cuenta: si no,
 * cualquiera que encuentre una sesión abierta se pone un PIN y opera como el
 * dueño de esa sesión desde ese momento en adelante.
 */
export const setMyPin = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const { currentPassword, pin } = req.body as { currentPassword: string; pin: string };

    const usuario = await reautenticar(authUser.id, currentPassword);
    if (!usuario) {
      return res.status(401).json({ error: "La contraseña no es correcta." });
    }

    const guardado = await guardarPin(authUser.id, pin, { mustChange: false });
    if (guardado.error) return res.status(guardado.status).json({ error: guardado.error });

    await prisma.auditLog.create({
      data: {
        actorUserId: authUser.id,
        action: "POS_PIN_SET",
        entityType: "PosPinCredential",
        entityId: String(authUser.id),
        // El hecho, no el valor.
        metadata: { self: true },
      },
    });

    res.json({
      message: "Tu PIN quedó configurado. Con él entrás a la caja sin cerrar sesión.",
    });
  } catch (error) {
    logger.error("Error al configurar el PIN:", error);
    res.status(500).json({ error: "No se pudo configurar el PIN." });
  }
};

/**
 * Escribe la credencial: hash para verificar + cifrado para el autorrevelado.
 *
 * Los dos usan SECRETOS DISTINTOS (`POS_PIN_PEPPER` y `POS_PIN_ENC_KEY`).
 * Compartirlos anularía el beneficio de tener dos: una sola filtración daría
 * verificación **y** revelado a la vez.
 */
const guardarPin = async (
  userId: number,
  pin: string,
  opciones: { mustChange: boolean },
): Promise<{ error?: string; status: number }> => {
  if (!isRevealAvailable()) {
    // Fallo cerrado para CREAR: guardar un PIN que después nadie va a poder ver
    // rompe la promesa que se le hizo al usuario. Verificar los ya existentes
    // sigue funcionando — eso es el modo degradado.
    return {
      status: 503,
      error:
        "El sistema no puede guardar PIN en este momento (falta configuración de seguridad " +
        "en el servidor). Avisale al administrador. Los PIN ya configurados siguen funcionando.",
    };
  }

  try {
    const [hash, cifrado] = await Promise.all([
      hashPin(pin),
      Promise.resolve(encryptPin(pin)),
    ]);

    await prisma.posPinCredential.upsert({
      where: { userId },
      create: {
        userId,
        pinHash: hash,
        pinCipher: cifrado.cipher,
        pinNonce: cifrado.nonce,
        pinTag: cifrado.tag,
        keyVersion: cifrado.keyVersion,
        mustChange: opciones.mustChange,
      },
      update: {
        pinHash: hash,
        pinCipher: cifrado.cipher,
        pinNonce: cifrado.nonce,
        pinTag: cifrado.tag,
        keyVersion: cifrado.keyVersion,
        mustChange: opciones.mustChange,
        isEnabled: true,
        lastChangedAt: new Date(),
        // Cambiar el PIN limpia el castigo de los intentos fallidos: quien
        // acaba de probar su contraseña ya demostró quién es.
        failedAttempts: 0,
        lockedUntil: null,
      },
    });

    return { status: 200 };
  } catch (error) {
    if (error instanceof PinConfigError) {
      return { status: 400, error: error.message };
    }
    throw error;
  }
};

/**
 * POST /me/pos-pin/reveal
 *
 * Ver el PIN propio. **POST y no GET**: un GET queda en el historial del
 * navegador, en los logs del proxy y en cualquier caché intermedia. Un secreto
 * no viaja en una URL.
 */
export const revealMyPin = async (req: AuthRequest, res: Response) => {
  sinCache(res);
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const { currentPassword } = req.body as { currentPassword: string };

    const usuario = await reautenticar(authUser.id, currentPassword);
    if (!usuario) {
      // Se audita el intento fallido: alguien probando contraseñas contra el
      // revelado de PIN es exactamente lo que hay que poder ver después.
      await prisma.auditLog
        .create({
          data: {
            actorUserId: authUser.id,
            action: "POS_PIN_REVEAL_DENIED",
            entityType: "PosPinCredential",
            entityId: String(authUser.id),
            metadata: { reason: "BAD_PASSWORD" },
          },
        })
        .catch(() => undefined);
      return res.status(401).json({ error: "La contraseña no es correcta." });
    }

    const credencial = await prisma.posPinCredential.findUnique({
      where: { userId: authUser.id },
    });

    if (!credencial) {
      return res.status(404).json({ error: "Todavía no configuraste tu PIN." });
    }
    if (!credencial.pinCipher || !credencial.pinNonce || !credencial.pinTag) {
      return res.status(409).json({
        error: "Tu PIN no se puede mostrar. Restablecelo para poder volver a verlo.",
      });
    }

    let pin: string;
    try {
      pin = decryptPin({
        cipher: credencial.pinCipher,
        nonce: credencial.pinNonce,
        tag: credencial.pinTag,
        keyVersion: credencial.keyVersion ?? 0,
      });
    } catch (error) {
      if (error instanceof PinConfigError) {
        return res.status(409).json({ error: error.message });
      }
      // Descifrado fallido con clave correcta = la fila fue manipulada. El tag
      // de GCM lo detecta, y es mejor no mostrar nada que mostrar basura.
      logger.error("Fallo al descifrar un PIN (posible manipulación de la fila).");
      return res.status(409).json({
        error: "Tu PIN no se pudo recuperar. Restablecelo desde acá mismo.",
      });
    }

    await prisma.$transaction([
      prisma.posPinCredential.update({
        where: { userId: authUser.id },
        data: { lastRevealAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          actorUserId: authUser.id,
          action: "POS_PIN_REVEALED",
          entityType: "PosPinCredential",
          entityId: String(authUser.id),
          // El HECHO. Nunca el valor.
          metadata: { self: true },
        },
      }),
    ]);

    res.json({
      data: {
        pin,
        // El frontend lo muestra este tiempo y después limpia el estado. No es
        // seguridad de verdad —quien lo vio ya lo vio— pero evita que quede en
        // pantalla cuando la persona se da vuelta a atender.
        visibleForSeconds: 15,
      },
    });
  } catch (error) {
    logger.error("Error al revelar el PIN:", error);
    res.status(500).json({ error: "No se pudo mostrar el PIN." });
  }
};

/**
 * DELETE /me/pos-pin
 *
 * Deshabilita el PIN propio y cierra las sesiones de POS abiertas con él. Si no
 * se cerraran, la caja donde alguien quedó identificado seguiría operando con
 * una credencial que su dueño acaba de dar de baja.
 */
export const disableMyPin = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const { currentPassword } = req.body as { currentPassword?: string };
    if (!currentPassword) {
      return res.status(400).json({ error: "Ingresá tu contraseña para continuar." });
    }

    const usuario = await reautenticar(authUser.id, currentPassword);
    if (!usuario) {
      return res.status(401).json({ error: "La contraseña no es correcta." });
    }

    const credencial = await prisma.posPinCredential.findUnique({
      where: { userId: authUser.id },
      select: { userId: true },
    });
    if (!credencial) {
      return res.status(404).json({ error: "No tenés un PIN configurado." });
    }

    await prisma.$transaction([
      prisma.posPinCredential.update({
        where: { userId: authUser.id },
        data: { isEnabled: false },
      }),
      prisma.posOperatorSession.updateMany({
        where: { userId: authUser.id, status: "ACTIVE" },
        data: { status: "CLOSED", endedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          actorUserId: authUser.id,
          action: "POS_PIN_DISABLED",
          entityType: "PosPinCredential",
          entityId: String(authUser.id),
          metadata: { self: true },
        },
      }),
    ]);

    res.json({ message: "Tu PIN quedó deshabilitado y se cerraron tus cajas abiertas." });
  } catch (error) {
    logger.error("Error al deshabilitar el PIN:", error);
    res.status(500).json({ error: "No se pudo deshabilitar el PIN." });
  }
};

/**
 * POST /users/:id/pos-pin/reset
 *
 * Restablece el PIN de OTRA persona — sin verlo nunca.
 *
 * Devuelve una credencial de activación de un solo uso. **No es un PIN**: no
 * sirve para entrar a ninguna caja. Su único poder es habilitar a su dueño a
 * elegir el suyo. Por eso un encargado puede entregarla sin quedar en posición
 * de operar como esa persona.
 */
export const resetOtherPin = async (req: AuthRequest, res: Response) => {
  sinCache(res);
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const targetId = Number(req.params.id);
    const { reason } = req.body as { reason: string };

    const objetivo = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, name: true, role: true },
    });
    if (!objetivo) return res.status(404).json({ error: "El usuario no existe." });

    // Un ENCARGADO no restablece el PIN de un ADMIN: sería escalar hacia arriba
    // por la puerta de servicio.
    if (authUser.role !== "ADMIN" && objetivo.role === "ADMIN") {
      return res.status(403).json({
        error: "No podés restablecer el PIN de un administrador.",
      });
    }

    const codigo = generateActivationCode();
    const expiresAt = new Date(Date.now() + ACTIVATION_TTL_MS);

    await prisma.$transaction([
      // Las credenciales pendientes anteriores se consumen: emitir una nueva
      // invalida la vieja, para que no queden invitaciones sueltas.
      prisma.posPinActivation.updateMany({
        where: { userId: targetId, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      prisma.posPinActivation.create({
        data: {
          userId: targetId,
          codeHash: sha256(codigo),
          issuedById: authUser.id,
          expiresAt,
        },
      }),
      // El PIN viejo deja de servir en el acto, y las cajas donde esa persona
      // estaba identificada se cierran. Si no, restablecer por sospecha de que
      // alguien lo vio no serviría de nada hasta el próximo cambio de turno.
      prisma.posPinCredential.updateMany({
        where: { userId: targetId },
        data: { isEnabled: false, failedAttempts: 0, lockedUntil: null },
      }),
      prisma.posOperatorSession.updateMany({
        where: { userId: targetId, status: "ACTIVE" },
        data: { status: "CLOSED", endedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          actorUserId: authUser.id,
          action: "POS_PIN_RESET_ISSUED",
          entityType: "User",
          entityId: String(targetId),
          metadata: { targetName: objetivo.name, reason },
        },
      }),
    ]);

    res.status(201).json({
      message:
        `Credencial generada para ${objetivo.name}. Se muestra UNA sola vez. ` +
        "No es un PIN: sirve para que esa persona elija el suyo.",
      data: {
        activationCredential: codigo, // ← única vez que existe en claro
        userName: objetivo.name,
        expiresAt,
        expiresInHours: Math.round(ACTIVATION_TTL_MS / 3_600_000),
      },
    });
  } catch (error) {
    logger.error("Error al restablecer el PIN de otro usuario:", error);
    res.status(500).json({ error: "No se pudo generar la credencial." });
  }
};

/**
 * POST /pos-pin/activate
 *
 * Canjea la credencial de activación por un PIN propio.
 *
 * No exige sesión iniciada: quien tiene la credencial puede estar frente a la
 * computadora del mostrador sin haber entrado nunca. La credencial ES la
 * autorización, y por eso vive poco y se consume al primer uso.
 */
export const activatePin = async (req: AuthRequest, res: Response) => {
  sinCache(res);
  try {
    const { activationCredential, pin } = req.body as {
      activationCredential: string;
      pin: string;
    };

    const activacion = await prisma.posPinActivation.findUnique({
      where: { codeHash: sha256(activationCredential) },
      include: { user: { select: { id: true, name: true } } },
    });

    // Mensaje idéntico para inexistente, usada y vencida: distinguirlos le diría
    // a quien prueba credenciales al azar cuál acertó.
    const invalida = () =>
      res.status(400).json({
        error: "La credencial de activación no es válida, ya se usó o venció.",
      });

    if (!activacion) return invalida();
    if (activacion.consumedAt) return invalida();
    if (activacion.expiresAt.getTime() < Date.now()) return invalida();

    const guardado = await guardarPin(activacion.userId, pin, { mustChange: false });
    if (guardado.error) return res.status(guardado.status).json({ error: guardado.error });

    await prisma.$transaction([
      prisma.posPinActivation.update({
        where: { id: activacion.id },
        data: { consumedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          actorUserId: activacion.userId,
          action: "POS_PIN_ACTIVATED",
          entityType: "PosPinCredential",
          entityId: String(activacion.userId),
          metadata: { activationId: activacion.id },
        },
      }),
    ]);

    res.json({
      message: `Listo, ${activacion.user.name}. Tu PIN quedó configurado.`,
    });
  } catch (error) {
    logger.error("Error al activar el PIN:", error);
    res.status(500).json({ error: "No se pudo activar el PIN." });
  }
};

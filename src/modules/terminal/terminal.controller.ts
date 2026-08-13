/**
 * Terminales físicas: administración y enrolamiento.
 *
 * Una terminal es la COMPUTADORA del mostrador, con su cajón. El enrolamiento
 * es lo que convierte la atribución de ventas en una garantía: sin él,
 * cualquiera con sesión válida puede declarar que está en otra caja.
 */

import { Response } from "express";

import prisma from "../../config/db";
import { logger } from "../../config/logger";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { isUniqueConstraintViolation } from "../../utils/stock.utils";
import {
  buildDeviceCookieValue,
  ENROLLMENT_TOKEN_TTL_MS,
  generateDeviceSecret,
  generateEnrollmentToken,
  sha256,
  TERMINAL_COOKIE,
  terminalCookieOptions,
} from "../../utils/terminalDevice.utils";

/**
 * GET /terminals
 *
 * El tablero que el dueño necesita para saber qué pasa en el mostrador: qué
 * caja está abierta, quién la abrió, cuándo se vio por última vez y si está
 * enrolada.
 */
export const listTerminals = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const branchId = req.query.branchId ? Number(req.query.branchId) : null;

    // Un no-ADMIN sólo ve las terminales de sus sucursales.
    const alcance =
      authUser.role === "ADMIN"
        ? branchId
          ? { branchId }
          : {}
        : { branchId: { in: authUser.branchIds } };

    const terminales = await prisma.terminal.findMany({
      where: alcance,
      orderBy: [{ branchId: "asc" }, { code: "asc" }],
      include: {
        branch: { select: { id: true, name: true } },
        cashRegisters: {
          where: { status: "OPEN" },
          take: 1,
          select: {
            id: true,
            openingTime: true,
            initialBalance: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    res.json({
      data: terminales.map((terminal) => ({
        id: terminal.id,
        code: terminal.code,
        name: terminal.name,
        branch: terminal.branch,
        status: terminal.status,
        // Se informa SI está enrolada, nunca el secreto ni su hash.
        enrolled: terminal.deviceSecretHash !== null,
        deviceSecretVersion: terminal.deviceSecretVersion,
        lastSeenAt: terminal.lastSeenAt,
        openShift: terminal.cashRegisters[0]
          ? {
              id: terminal.cashRegisters[0].id,
              openedAt: terminal.cashRegisters[0].openingTime,
              openedBy: terminal.cashRegisters[0].user,
              initialBalance: terminal.cashRegisters[0].initialBalance,
            }
          : null,
      })),
    });
  } catch (error) {
    logger.error("Error al listar terminales:", error);
    res.status(500).json({ error: "No se pudieron obtener las terminales." });
  }
};

/** POST /terminals */
export const createTerminal = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const { code, name, branchId } = req.body;
    const parsedBranchId = Number(branchId);

    const sucursal = await prisma.branch.findUnique({ where: { id: parsedBranchId } });
    if (!sucursal) {
      return res.status(400).json({ error: "La sucursal indicada no existe." });
    }

    const terminal = await prisma.terminal.create({
      data: {
        code: String(code).trim().toUpperCase(),
        name: String(name).trim(),
        branchId: parsedBranchId,
      },
      include: { branch: { select: { id: true, name: true } } },
    });

    res.status(201).json({
      message: `Terminal "${terminal.code}" creada en ${terminal.branch.name}.`,
      data: terminal,
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      return res.status(409).json({
        error: "Ya existe una terminal con ese código. Los códigos son únicos.",
      });
    }
    logger.error("Error al crear terminal:", error);
    res.status(500).json({ error: "No se pudo crear la terminal." });
  }
};

/** PATCH /terminals/:id — renombrar, mover de sucursal, activar/desactivar. */
export const updateTerminal = async (req: AuthRequest, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { name, branchId, status } = req.body;

    const actual = await prisma.terminal.findUnique({ where: { id } });
    if (!actual) return res.status(404).json({ error: "Terminal no encontrada." });

    // Mover una terminal de sucursal con la caja abierta partiría el arqueo al
    // medio: las ventas del turno quedarían repartidas entre dos sucursales.
    if (branchId !== undefined && Number(branchId) !== actual.branchId) {
      const turnoAbierto = await prisma.cashRegister.findFirst({
        where: { terminalId: id, status: "OPEN" },
      });
      if (turnoAbierto) {
        return res.status(409).json({
          error:
            "No se puede cambiar de sucursal una terminal con la caja abierta. " +
            "Cerrá el turno primero.",
        });
      }
    }

    const terminal = await prisma.terminal.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name: String(name).trim() } : {}),
        ...(branchId !== undefined ? { branchId: Number(branchId) } : {}),
        ...(status !== undefined ? { status } : {}),
      },
      include: { branch: { select: { id: true, name: true } } },
    });

    res.json({ message: "Terminal actualizada.", data: terminal });
  } catch (error) {
    logger.error("Error al actualizar terminal:", error);
    res.status(500).json({ error: "No se pudo actualizar la terminal." });
  }
};

/**
 * POST /terminals/:id/enrollment
 *
 * Emite un token de un solo uso. **Se devuelve en claro UNA sola vez**: en la
 * base queda sólo su hash, así que ni un volcado de la base permite enrolar una
 * máquina ajena.
 */
export const issueEnrollmentToken = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const terminalId = Number(req.params.id);
    const terminal = await prisma.terminal.findUnique({ where: { id: terminalId } });
    if (!terminal) return res.status(404).json({ error: "Terminal no encontrada." });
    if (terminal.status !== "ACTIVE") {
      return res.status(400).json({
        error: "No se puede enrolar una terminal desactivada. Activala primero.",
      });
    }

    const token = generateEnrollmentToken();
    const expiresAt = new Date(Date.now() + ENROLLMENT_TOKEN_TTL_MS);

    // Los tokens pendientes anteriores se consumen: emitir uno nuevo invalida
    // el viejo, para que no queden invitaciones sueltas dando vueltas.
    await prisma.$transaction([
      prisma.terminalEnrollment.updateMany({
        where: { terminalId, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      prisma.terminalEnrollment.create({
        data: {
          terminalId,
          tokenHash: sha256(token),
          issuedById: authUser.id,
          expiresAt,
        },
      }),
    ]);

    res.status(201).json({
      message:
        "Token generado. Se muestra UNA sola vez: copialo y usalo en la computadora que querés enrolar.",
      data: {
        token, // ← única vez que existe en claro
        terminalCode: terminal.code,
        expiresAt,
        expiresInMinutes: Math.round(ENROLLMENT_TOKEN_TTL_MS / 60000),
      },
    });
  } catch (error) {
    logger.error("Error al emitir token de enrolamiento:", error);
    res.status(500).json({ error: "No se pudo generar el token." });
  }
};

/**
 * POST /terminals/enroll
 *
 * Canjea el token por la credencial de dispositivo, que viaja en una cookie
 * HttpOnly. A partir de acá esta computadora ES esa terminal, y no hace falta
 * (ni se acepta) que lo declare en ningún request.
 */
export const enrollDevice = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!token) {
      return res.status(400).json({ error: "Falta el token de enrolamiento." });
    }

    // Se busca por HASH: el token en claro no existe en ningún lado.
    const enrolamiento = await prisma.terminalEnrollment.findUnique({
      where: { tokenHash: sha256(token) },
      include: { terminal: true },
    });

    // Mensaje deliberadamente idéntico para token inexistente, usado o vencido:
    // distinguirlos le diría a quien prueba tokens al azar cuál acertó.
    const invalido = () =>
      res.status(400).json({
        error: "El token de enrolamiento no es válido, ya se usó o venció.",
      });

    if (!enrolamiento) return invalido();
    if (enrolamiento.consumedAt) return invalido();
    if (enrolamiento.expiresAt.getTime() < Date.now()) return invalido();
    if (enrolamiento.terminal.status !== "ACTIVE") return invalido();

    // Quien enrola tiene que tener acceso a la sucursal de la terminal.
    if (
      authUser.role !== "ADMIN" &&
      !authUser.branchIds.includes(enrolamiento.terminal.branchId)
    ) {
      return res.status(403).json({
        error: "No tenés acceso a la sucursal de esta terminal.",
      });
    }

    const secret = generateDeviceSecret();
    // Se incrementa la versión: cualquier credencial anterior de esta terminal
    // deja de validar en el acto, sin depender de que el navegador borre nada.
    const version = enrolamiento.terminal.deviceSecretVersion + 1;

    await prisma.$transaction([
      prisma.terminal.update({
        where: { id: enrolamiento.terminalId },
        data: {
          deviceSecretHash: sha256(secret),
          deviceSecretVersion: version,
          lastSeenAt: new Date(),
        },
      }),
      prisma.terminalEnrollment.update({
        where: { id: enrolamiento.id },
        data: { consumedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: enrolamiento.terminal.branchId,
          action: "TERMINAL_ENROLLED",
          entityType: "Terminal",
          entityId: String(enrolamiento.terminalId),
          // Nunca el secreto ni el token: sólo el hecho.
          metadata: { terminalCode: enrolamiento.terminal.code, version },
        },
      }),
    ]);

    res.cookie(
      TERMINAL_COOKIE,
      buildDeviceCookieValue(enrolamiento.terminalId, version, secret),
      terminalCookieOptions(),
    );

    res.json({
      message: `Esta computadora quedó enrolada como "${enrolamiento.terminal.code}".`,
      data: {
        terminalId: enrolamiento.terminalId,
        code: enrolamiento.terminal.code,
        name: enrolamiento.terminal.name,
        branchId: enrolamiento.terminal.branchId,
      },
    });
  } catch (error) {
    logger.error("Error al enrolar dispositivo:", error);
    res.status(500).json({ error: "No se pudo completar el enrolamiento." });
  }
};

/**
 * POST /terminals/:id/revoke
 *
 * Corta el acceso de la computadora enrolada. Al incrementar la versión, la
 * credencial que tenga guardada deja de servir aunque nadie la borre — que es
 * lo que hace falta cuando una máquina se pierde o se roba.
 */
export const revokeTerminalDevice = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const id = Number(req.params.id);
    const terminal = await prisma.terminal.findUnique({ where: { id } });
    if (!terminal) return res.status(404).json({ error: "Terminal no encontrada." });

    await prisma.$transaction([
      prisma.terminal.update({
        where: { id },
        data: {
          deviceSecretHash: null,
          deviceSecretVersion: terminal.deviceSecretVersion + 1,
        },
      }),
      prisma.terminalEnrollment.updateMany({
        where: { terminalId: id, consumedAt: null },
        data: { consumedAt: new Date() },
      }),
      prisma.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: terminal.branchId,
          action: "TERMINAL_DEVICE_REVOKED",
          entityType: "Terminal",
          entityId: String(id),
          metadata: { terminalCode: terminal.code },
        },
      }),
    ]);

    res.json({
      message: `Se revocó el acceso de la computadora enrolada en "${terminal.code}". ` +
        "Para volver a operar hay que enrolarla de nuevo.",
    });
  } catch (error) {
    logger.error("Error al revocar terminal:", error);
    res.status(500).json({ error: "No se pudo revocar la terminal." });
  }
};

/** GET /terminals/me — qué terminal es esta computadora, según la cookie. */
export const whoAmI = async (req: AuthRequest, res: Response) => {
  const terminal = req.terminal;
  if (!terminal) {
    return res.json({ data: null, enrolled: false });
  }
  res.json({
    data: {
      id: terminal.id,
      code: terminal.code,
      name: terminal.name,
      branchId: terminal.branchId,
    },
    enrolled: true,
  });
};

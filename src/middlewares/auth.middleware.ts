import { Request, Response, NextFunction } from "express";
import { logger } from "../config/logger";
import jwt, { JwtPayload } from "jsonwebtoken";

import type { AuthLevel } from "../utils/session.utils";

export interface AuthenticatedUser {
  id: number;
  role: string;
  branchIds: number[];
  /**
   * Cómo se probó esta identidad: con contraseña, o con el código de seis
   * dígitos de una terminal del mostrador. Ver `requireFullAuth`.
   */
  authLevel: AuthLevel;
}

export interface AuthRequest extends Request {
  user?: AuthenticatedUser;
}

const toNumberArray = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
};

const parseAuthenticatedUser = (
  decoded: string | JwtPayload,
): AuthenticatedUser | null => {
  if (typeof decoded === "string") return null;

  const id = Number(decoded.id);
  const role = typeof decoded.role === "string" ? decoded.role : "";
  const branchIds = toNumberArray(decoded.branchIds);

  if (!Number.isInteger(id) || id <= 0 || role.trim() === "") {
    return null;
  }

  /**
   * Los tokens emitidos ANTES de que existiera el acceso por código no traen
   * este campo. Se los toma como `PASSWORD`, que es literalmente cómo se
   * emitieron: en ese momento la contraseña era la única puerta.
   *
   * Tomarlos como `PIN` habría dejado a todo el mundo que ya tenía sesión
   * abierta sin poder administrar nada hasta que su token venciera.
   */
  const authLevel: AuthLevel = decoded.authLevel === "PIN" ? "PIN" : "PASSWORD";

  return { id, role, branchIds, authLevel };
};

export const getAuthUser = (
  req: Request | AuthRequest,
): AuthenticatedUser | null => {
  const user = (req as AuthRequest).user;
  return user ?? null;
};

export const authenticateToken = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error("JWT_SECRET no detectado en las variables de entorno.");
    }

    // Priority 1: HttpOnly cookie (secure, XSS-resistant)
    // Priority 2: Bearer token header (kept for backwards compat during transition)
    let token: string | undefined = req.cookies?.club_token;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        token = authHeader.split(" ")[1];
      }
    }

    if (!token) {
      return res.status(401).json({
        error: "Acceso denegado. Se requiere un token de seguridad.",
      });
    }

    const decoded = jwt.verify(token, secret);
    const authenticatedUser = parseAuthenticatedUser(decoded);

    if (!authenticatedUser) {
      // 401, not 403: this is an authentication failure (bad token), not a
      // permission denial. The frontend interceptor redirects to login on 401.
      return res.status(401).json({
        error: "El token recibido no contiene una identidad válida.",
      });
    }

    req.user = authenticatedUser;
    next();
  } catch (error) {
    logger.error("Fallo critico en validacion de identidad:", error);
    // Expired/invalid JWT → 401 so the client cleanly redirects to re-login.
    res.status(401).json({
      error: "Sesión inválida o expirada. Por favor, reingresá al sistema.",
    });
  }
};

/**
 * Exige que la sesión se haya abierto con CONTRASEÑA, no con el código del
 * mostrador.
 *
 * ── Por qué hace falta ──────────────────────────────────────────────────────
 *
 * El acceso por código existe para que el mostrador no pierda tiempo: se marcan
 * seis dígitos y se vende. Pero el dueño también atiende, y su código le abre
 * una sesión con rol ADMIN. Sin este guardián, seis dígitos tipeados en una
 * computadora que está sobre el mostrador —a la vista de cualquiera que espere
 * su turno— alcanzarían para borrar usuarios, cambiar precios masivamente o
 * restablecer la contraseña de otro.
 *
 * Un PIN corto es razonable para autorizar una venta. No lo es para
 * administrar el sistema. Para eso se entra con la cuenta.
 *
 * Devuelve 403 y no 401 a propósito: la sesión es válida, lo que falta es
 * jerarquía de prueba. Un 401 haría que el interceptor del front la cerrara,
 * que es exactamente lo contrario de lo que se quiere — la persona no perdió la
 * sesión, sólo necesita volver a identificarse para ESTA acción.
 */
export const requireFullAuth = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): void => {
  const user = getAuthUser(req);

  if (!user) {
    res.status(401).json({ error: "Sesión inválida." });
    return;
  }

  if (user.authLevel !== "PASSWORD") {
    res.status(403).json({
      error:
        "Esta acción necesita que entres con tu email y contraseña. " +
        "El código de la terminal alcanza para vender, no para administrar el sistema.",
      code: "PASSWORD_REQUIRED",
    });
    return;
  }

  next();
};

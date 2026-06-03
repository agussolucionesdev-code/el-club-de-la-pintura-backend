import { Request, Response, NextFunction } from "express";
import { logger } from '../config/logger';
import jwt, { JwtPayload } from "jsonwebtoken";

export interface AuthenticatedUser {
  id: number;
  role: string;
  branchIds: number[];
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

  return { id, role, branchIds };
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
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Acceso denegado. Se requiere un token de seguridad.",
      });
    }

    const token = authHeader.split(" ")[1];
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      throw new Error("JWT_SECRET no detectado en las variables de entorno.");
    }

    if (!token) {
      return res.status(401).json({
        error: "Estructura de token invalida.",
      });
    }

    const decoded = jwt.verify(token, secret);
    const authenticatedUser = parseAuthenticatedUser(decoded);

    if (!authenticatedUser) {
      return res.status(403).json({
        error: "El token recibido no contiene una identidad válida.",
      });
    }

    req.user = authenticatedUser;

    next();
  } catch (error) {
    logger.error("Fallo critico en validacion de identidad:", error);
    res.status(403).json({
      error: "Sesion invalida o expirada. Por favor, reingrese al sistema.",
    });
  }
};

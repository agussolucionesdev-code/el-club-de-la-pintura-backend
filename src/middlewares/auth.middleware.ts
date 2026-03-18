import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// Extensión de la interfaz global Request de Express
export interface AuthRequest extends Request {
  user?: string | jwt.JwtPayload;
}

// INTERCEPTOR DE SEGURIDAD: Validación de Identidad (JWT)
// Acción: Desencriptación y verificación de firmas criptográficas
export const authenticateToken = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;

    // 1. Verificación de presencia de cabecera
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Acceso denegado. Se requiere un token de seguridad.",
      });
    }

    const token = authHeader.split(" ")[1];
    const secret = process.env.JWT_SECRET;

    // 2. Validación de integridad de la clave maestra
    if (!secret) {
      throw new Error("JWT_SECRET no detectado en las variables de entorno.");
    }

    // 3. Validación de integridad del token
    if (!token) {
      return res.status(401).json({
        error: "Estructura de token inválida.",
      });
    }

    // SOLUCIÓN AL ERROR TS2769:
    // Aplicamos 'as string' para garantizar a TypeScript que los valores son válidos
    // después de haber pasado los filtros de seguridad anteriores.
    const decoded = jwt.verify(token as string, secret as string);

    // 4. Inyección del payload decodificado en la solicitud
    req.user = decoded;

    next();
  } catch (error) {
    console.error("Fallo crítico en validación de identidad:", error);
    res.status(403).json({
      error: "Sesión inválida o expirada. Por favor, reingrese al sistema.",
    });
  }
};

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// Extensión de la interfaz global Request de Express
// Inyección dinámica de la propiedad 'user' para el transporte del payload del token
export interface AuthRequest extends Request {
  user?: string | jwt.JwtPayload;
}

// Intercepción y validación criptográfica de JSON Web Tokens (JWT)
// Verificación de cabeceras de autorización para el control de acceso a rutas protegidas
export const verifyToken = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    // Extracción de la cabecera de autorización HTTP
    const authHeader = req.headers.authorization;

    // Validación de presencia del token y del formato estándar 'Bearer'
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Acceso denegado. Se requiere un token de autenticación válido.",
      });
    }

    // Aislamiento del token alfanumérico (Remoción del prefijo 'Bearer ')
    const token = authHeader.split(" ")[1];

    // Validación estricta de existencia del token para satisfacción del compilador TS
    if (!token) {
      return res.status(401).json({
        error:
          "Formato de token inválido. Estructura requerida: 'Bearer <token>'.",
      });
    }

    // Verificación de existencia de la firma secreta en el entorno
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error(
        "Clave de firma JWT_SECRET no configurada en el entorno.",
      );
    }

    // Desencriptación y validación matemática del token
    // Aplicación de aserción de tipos para garantizar el contrato de la librería JWT
    const decoded = jwt.verify(token as string, secret as string);

    // Asignación del payload decodificado al objeto de la solicitud para su uso posterior
    req.user = decoded;

    // Delegación del control al siguiente middleware o controlador correspondiente
    next();
  } catch (error) {
    console.error("Error en la validación del token de seguridad:", error);
    res.status(403).json({
      error: "Token inválido o expirado. Inicie sesión nuevamente.",
    });
  }
};

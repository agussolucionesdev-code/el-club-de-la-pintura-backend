import { Request, Response, NextFunction } from "express";

// Interceptor Global de Errores (El Escudo)
export const globalErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  console.error("🚨 [CRASH PREVENIDO POR JIMMY]:", err.message || err);

  // Si el error es de validación (Zod) o un error nuestro controlado
  const statusCode = err.statusCode || 500;

  // Mensaje amigable para que el Frontend lo muestre en una alerta bonita
  const message = err.message || "Fallo estructural interno en el servidor.";

  res.status(statusCode).json({
    status: "error",
    statusCode,
    message,
    // (Opcional: En producción podríamos ocultar la ruta exacta por seguridad)
    path: req.originalUrl,
    timestamp: new Date().toISOString(),
  });
};

// Interceptor para rutas que no existen (Error 404)
export const notFoundHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.status(404).json({
    status: "error",
    statusCode: 404,
    message: `La ruta solicitada (${req.originalUrl}) no existe en el sistema.`,
  });
};

import { Request, Response, NextFunction } from "express";
import { logger } from '../config/logger';

// Global error interceptor — last-resort Express error handler
export const globalErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  logger.error("[UNHANDLED ERROR]:", err.message || err);

  // Use the error's own status code if set, otherwise default to 500
  const statusCode = err.statusCode || 500;

  // Human-readable message forwarded to the frontend for display
  const message = err.message || "Fallo estructural interno en el servidor.";

  const body: Record<string, unknown> = {
    status: "error",
    statusCode,
    message,
    timestamp: new Date().toISOString(),
  };

  // Only expose the route path in non-production environments to avoid
  // leaking internal route structure to external callers.
  if (process.env.NODE_ENV !== "production") {
    body.path = req.originalUrl;
  }

  res.status(statusCode).json(body);
};

// 404 handler — catches requests to undefined routes
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

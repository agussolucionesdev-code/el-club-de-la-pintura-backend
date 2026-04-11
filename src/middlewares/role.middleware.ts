import { Request, Response, NextFunction } from "express";
import { AuthRequest } from "./auth.middleware";

export const authorizeRoles = (...allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as AuthRequest).user;

    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(403).json({
        error:
          "Acceso denegado. Tu perfil comercial no tiene los privilegios necesarios para realizar esta accion.",
      });
    }

    next();
  };
};

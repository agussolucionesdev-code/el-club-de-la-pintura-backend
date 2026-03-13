import { Request, Response, NextFunction } from "express";

// Candado de Seguridad de Roles (RBAC)
// Intercepta la petición y verifica si el rol del usuario está dentro de los permitidos
export const authorizeRoles = (...allowedRoles: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Extraemos el usuario que nuestro auth.middleware ya decodificó del Token
    const user = (req as any).user;

    // Si no hay usuario, o su rol no está en la lista de permitidos, se bloquea el acceso
    if (!user || !allowedRoles.includes(user.role)) {
      return res.status(403).json({
        error:
          "Acceso denegado. Tu perfil comercial no tiene los privilegios necesarios para realizar esta acción.",
      });
    }

    // Si el rol es correcto, pasa al controlador en caso contrario, no pasa.
    next();
  };
};

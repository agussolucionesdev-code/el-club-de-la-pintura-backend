import { NextFunction, Request, Response } from "express";
import { AuthRequest, getAuthUser } from "./auth.middleware";

interface BranchAccessOptions {
  allowAllBranches?: boolean;
  allowMissingBranch?: boolean;
}

const parseBranchId = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") return null;

  const branchId = Number(value);
  return Number.isInteger(branchId) && branchId >= 0 ? branchId : null;
};

const extractRequestedBranchId = (req: Request): number | null => {
  const fromParams = parseBranchId(req.params.branchId);
  if (fromParams !== null) return fromParams;

  const fromBody = parseBranchId((req.body as { branchId?: unknown }).branchId);
  if (fromBody !== null) return fromBody;

  const fromQuery = parseBranchId(req.query.branchId);
  if (fromQuery !== null) return fromQuery;

  return null;
};

export const authorizeBranchAccess =
  (options: BranchAccessOptions = {}) =>
  (req: AuthRequest, res: Response, next: NextFunction) => {
    const user = getAuthUser(req);

    if (!user) {
      return res.status(401).json({
        error: "No se pudo validar la identidad operativa del usuario.",
      });
    }

    if (user.role === "ADMIN") {
      return next();
    }

    const branchId = extractRequestedBranchId(req);

    if (branchId === null) {
      if (options.allowMissingBranch) return next();

      return res.status(400).json({
        error: "La sucursal objetivo es obligatoria para esta operacion.",
      });
    }

    if (branchId === 0) {
      if (options.allowAllBranches) return next();

      return res.status(403).json({
        error: "Este perfil no puede operar sobre todas las sucursales.",
      });
    }

    if (!user.branchIds.includes(branchId)) {
      return res.status(403).json({
        error: "No tienes permisos para operar sobre la sucursal indicada.",
      });
    }

    return next();
  };

/**
 * Branch Controller — sucursal (location) management.
 *
 * Manages the multi-branch structure of the ERP. Each branch has its own:
 * stock, cash register shifts, expenses, and assigned employees.
 *
 * Deletion is blocked when a branch has related data (users, stock, movements,
 * cash registers, sales, expenses). The `deleteAllBranches` endpoint requires
 * an explicit confirmation phrase and is reserved for onboarding resets.
 *
 * @module branch.controller
 */
import { Request, Response } from "express";
import { logger } from '../../config/logger';
import { Prisma } from "@prisma/client";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

type BranchDeletionBlockers = Record<string, number>;

const countBranchDeletionBlockers = async (
  branchId: number,
): Promise<BranchDeletionBlockers> => {
  const [
    users,
    stocks,
    movements,
    sales,
    payments,
    cashRegisters,
    expenses,
    outgoingTransfers,
    incomingTransfers,
    purchaseOrders,
    purchaseReceipts,
    internalReceipts,
    syncOperations,
    syncCheckpoints,
  ] = await Promise.all([
    prisma.user.count({ where: { branches: { some: { id: branchId } } } }),
    prisma.stock.count({ where: { branchId } }),
    prisma.movement.count({ where: { branchId } }),
    prisma.sale.count({ where: { branchId } }),
    prisma.payment.count({ where: { branchId } }),
    prisma.cashRegister.count({ where: { branchId } }),
    prisma.expense.count({ where: { branchId } }),
    prisma.stockTransfer.count({ where: { fromBranchId: branchId } }),
    prisma.stockTransfer.count({ where: { toBranchId: branchId } }),
    prisma.purchaseOrder.count({ where: { branchId } }),
    prisma.purchaseReceipt.count({ where: { branchId } }),
    prisma.internalReceipt.count({ where: { branchId } }),
    prisma.syncOperation.count({ where: { branchId } }),
    prisma.syncCheckpoint.count({ where: { branchId } }),
  ]);

  return {
    users,
    stocks,
    movements,
    sales,
    payments,
    cashRegisters,
    expenses,
    outgoingTransfers,
    incomingTransfers,
    purchaseOrders,
    purchaseReceipts,
    internalReceipts,
    syncOperations,
    syncCheckpoints,
  };
};

const hasBlockers = (blockers: BranchDeletionBlockers) =>
  Object.values(blockers).some((count) => count > 0);

const parseBranchId = (id: unknown) => {
  const branchId = Number(id);
  return Number.isInteger(branchId) && branchId > 0 ? branchId : null;
};

const normalizeBranchName = (name: unknown) =>
  String(name || "").trim().replace(/\s+/g, " ");

const findBranchNameConflict = (name: string, exceptBranchId?: number) =>
  prisma.branch.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      ...(exceptBranchId ? { id: { not: exceptBranchId } } : {}),
    },
    select: { id: true, name: true },
  });

const toJsonPayload = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const auditBranchAction = async (
  req: Request,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) => {
  const authUser = getAuthUser(req as AuthRequest);
  if (!authUser) return;

  await prisma.auditLog.create({
    data: {
      actorUserId: authUser.id,
      action,
      entityType: "Branch",
      entityId,
      metadata: toJsonPayload(metadata),
    },
  });
};

/**
 * GET /branches
 *
 * Returns all branches visible to the authenticated user. ADMIN sees all;
 * ENCARGADO/EMPLOYEE see only their assigned branches.
 */
export const getBranches = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const branches = await prisma.branch.findMany({
      where:
        authUser.role === "ADMIN"
          ? { isActive: true }
          : { id: { in: authUser.branchIds }, isActive: true },
      orderBy: { name: "asc" },
    });

    res.status(200).json(branches);
  } catch (error) {
    logger.error("Error al buscar las sucursales:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al obtener las sucursales." });
  }
};

/**
 * POST /branches
 *
 * Creates a new branch. Names are trimmed and uppercased for consistency.
 * Returns 409 if a branch with the same name already exists.
 * Access: ADMIN only.
 */
export const createBranch = async (req: Request, res: Response) => {
  try {
    const { name, location } = req.body;
    const trimmedName = normalizeBranchName(name);

    if (trimmedName.length < 2) {
      return res
        .status(400)
        .json({ error: "El nombre de la sucursal es requerido." });
    }

    const existingBranch = await findBranchNameConflict(trimmedName);
    if (existingBranch) {
      return res.status(409).json({
        error: "Ya existe una sucursal con ese nombre.",
        data: { existingBranch },
      });
    }

    const newBranch = await prisma.branch.create({
      data: {
        name: trimmedName,
        location: location ? String(location).trim() : null,
      },
    });

    await auditBranchAction(req, "branch.created", String(newBranch.id), {
      name: newBranch.name,
      location: newBranch.location,
    });

    res.status(201).json(newBranch);
  } catch (error) {
    logger.error("Error al crear la sucursal:", error);
    res.status(500).json({ error: "Hubo un problema al crear la sucursal." });
  }
};

/**
 * PUT /branches/:id — Updates branch name and/or location. Access: ADMIN only.
 * @param id - Branch ID.
 */
export const updateBranch = async (req: Request, res: Response) => {
  try {
    const branchId = parseBranchId(req.params.id);
    const { name, location } = req.body;
    const trimmedName = normalizeBranchName(name);

    if (!branchId) {
      return res.status(400).json({ error: "Sucursal invalida." });
    }

    if (trimmedName.length < 2) {
      return res
        .status(400)
        .json({ error: "El nombre de la sucursal es requerido." });
    }

    const currentBranch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true },
    });
    if (!currentBranch) {
      return res.status(404).json({ error: "Sucursal no encontrada." });
    }

    const existingBranch = await findBranchNameConflict(trimmedName, branchId);
    if (existingBranch) {
      return res.status(409).json({
        error: "Ya existe otra sucursal con ese nombre.",
        data: { existingBranch },
      });
    }

    const updatedBranch = await prisma.branch.update({
      where: { id: branchId },
      data: {
        name: trimmedName,
        location: location ? String(location).trim() : null,
      },
    });

    await auditBranchAction(req, "branch.updated", String(updatedBranch.id), {
      name: updatedBranch.name,
      location: updatedBranch.location,
    });

    res.status(200).json(updatedBranch);
  } catch (error) {
    logger.error("Error al actualizar la sucursal:", error);
    res
      .status(500)
      .json({ error: "No se pudo actualizar la sucursal. Verifique el ID." });
  }
};

/**
 * DELETE /branches/:id
 *
 * Hard-deletes a branch. Returns 409 with a blocker summary if the branch has
 * linked data (users, stock records, movements, cash registers, sales, or expenses).
 * Access: ADMIN only.
 *
 * @param id - Branch ID.
 */
export const deleteBranch = async (req: Request, res: Response) => {
  try {
    const branchId = parseBranchId(req.params.id);

    if (!branchId) {
      return res.status(400).json({ error: "Sucursal invalida." });
    }

    const currentBranch = await prisma.branch.findUnique({
      where: { id: branchId },
      select: { id: true },
    });
    if (!currentBranch) {
      return res.status(404).json({ error: "Sucursal no encontrada." });
    }

    const blockers = await countBranchDeletionBlockers(branchId);
    if (hasBlockers(blockers)) {
      return res.status(409).json({
        error:
          "No se puede eliminar una sucursal con usuarios, stock, caja o historial operativo asociado.",
        data: { branchId, blockers },
      });
    }

    const deletedBranch = await prisma.branch.delete({ where: { id: branchId } });

    await auditBranchAction(req, "branch.deleted", String(branchId), {
      name: deletedBranch.name,
      location: deletedBranch.location,
    });

    res.status(200).json({ message: "Sucursal eliminada correctamente." });
  } catch (error) {
    logger.error("Error al eliminar la sucursal:", error);
    res
      .status(500)
      .json({ error: "No se pudo eliminar la sucursal. Verifique el ID." });
  }
};

/**
 * DELETE /branches/all
 *
 * Hard-deletes ALL branches. Requires confirmation phrase `"CONFIRMAR_BORRADO"`.
 * Intended for onboarding resets only. Access: ADMIN only.
 *
 * @body confirmationPhrase - Must equal `"CONFIRMAR_BORRADO"`.
 */
export const deleteAllBranches = async (req: Request, res: Response) => {
  try {
    const { confirmationPhrase, expectedBranchCount } = req.body || {};
    const requiredPhrase = "ELIMINAR SUCURSALES";

    if (confirmationPhrase !== requiredPhrase) {
      return res.status(400).json({
        error: `Confirmacion requerida: envie la frase exacta ${requiredPhrase}.`,
      });
    }

    const branches = await prisma.branch.findMany({
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    });
    const expectedCount = Number(expectedBranchCount);

    if (
      expectedBranchCount !== undefined &&
      (!Number.isInteger(expectedCount) || expectedCount !== branches.length)
    ) {
      return res.status(409).json({
        error:
          "Las sucursales cambiaron desde que se inicio la accion. Actualice la pantalla y vuelva a confirmar.",
        data: {
          expectedBranchCount,
          currentBranchCount: branches.length,
        },
      });
    }

    const blockersByBranch = await Promise.all(
      branches.map(async (branch) => ({
        id: branch.id,
        name: branch.name,
        blockers: await countBranchDeletionBlockers(branch.id),
      })),
    );
    const blockedBranches = blockersByBranch.filter((branch) =>
      hasBlockers(branch.blockers),
    );

    if (blockedBranches.length > 0) {
      return res.status(409).json({
        error:
          "No se pueden eliminar todas las sucursales porque existen usuarios, stock, caja o historial operativo asociado.",
        data: { blockedBranches },
      });
    }

    const result = await prisma.branch.deleteMany({});

    await auditBranchAction(req, "branch.bulk_deleted", "ALL", {
      deletedCount: result.count,
    });

    res.status(200).json({
      message: "Sucursales eliminadas correctamente.",
      deletedCount: result.count,
    });
  } catch (error) {
    logger.error("Error al eliminar todas las sucursales:", error);
    res.status(500).json({
      error: "No se pudieron eliminar masivamente las sucursales.",
    });
  }
};

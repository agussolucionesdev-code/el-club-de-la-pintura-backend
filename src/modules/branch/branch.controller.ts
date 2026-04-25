import { Request, Response } from "express";
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
          ? undefined
          : { id: { in: authUser.branchIds } },
      orderBy: { name: "asc" },
    });

    res.status(200).json(branches);
  } catch (error) {
    console.error("Error al buscar las sucursales:", error);
    res
      .status(500)
      .json({ error: "Hubo un problema al obtener las sucursales." });
  }
};

export const createBranch = async (req: Request, res: Response) => {
  try {
    const { name, location } = req.body;
    const trimmedName = String(name || "").trim();

    if (trimmedName.length < 2) {
      return res
        .status(400)
        .json({ error: "El nombre de la sucursal es requerido." });
    }

    const newBranch = await prisma.branch.create({
      data: {
        name: trimmedName,
        location: location ? String(location).trim() : null,
      },
    });

    res.status(201).json(newBranch);
  } catch (error) {
    console.error("Error al crear la sucursal:", error);
    res.status(500).json({ error: "Hubo un problema al crear la sucursal." });
  }
};

export const updateBranch = async (req: Request, res: Response) => {
  try {
    const branchId = parseBranchId(req.params.id);
    const { name, location } = req.body;
    const trimmedName = String(name || "").trim();

    if (!branchId) {
      return res.status(400).json({ error: "Sucursal invalida." });
    }

    if (trimmedName.length < 2) {
      return res
        .status(400)
        .json({ error: "El nombre de la sucursal es requerido." });
    }

    const updatedBranch = await prisma.branch.update({
      where: { id: branchId },
      data: {
        name: trimmedName,
        location: location ? String(location).trim() : null,
      },
    });

    res.status(200).json(updatedBranch);
  } catch (error) {
    console.error("Error al actualizar la sucursal:", error);
    res
      .status(500)
      .json({ error: "No se pudo actualizar la sucursal. Verifique el ID." });
  }
};

export const deleteBranch = async (req: Request, res: Response) => {
  try {
    const branchId = parseBranchId(req.params.id);

    if (!branchId) {
      return res.status(400).json({ error: "Sucursal invalida." });
    }

    const blockers = await countBranchDeletionBlockers(branchId);
    if (hasBlockers(blockers)) {
      return res.status(409).json({
        error:
          "No se puede eliminar una sucursal con usuarios, stock, caja o historial operativo asociado.",
        data: { branchId, blockers },
      });
    }

    await prisma.branch.delete({ where: { id: branchId } });

    res.status(200).json({ message: "Sucursal eliminada correctamente." });
  } catch (error) {
    console.error("Error al eliminar la sucursal:", error);
    res
      .status(500)
      .json({ error: "No se pudo eliminar la sucursal. Verifique el ID." });
  }
};

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

    res.status(200).json({
      message: "Sucursales eliminadas correctamente.",
      deletedCount: result.count,
    });
  } catch (error) {
    console.error("Error al eliminar todas las sucursales:", error);
    res.status(500).json({
      error: "No se pudieron eliminar masivamente las sucursales.",
    });
  }
};

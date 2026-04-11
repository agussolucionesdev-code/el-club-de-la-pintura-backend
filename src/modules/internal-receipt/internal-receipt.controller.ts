import { Response } from "express";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

const buildReceiptBranchWhere = (
  rawBranchId: unknown,
  authUser: { role: string; branchIds: number[] },
) => {
  const branchId = rawBranchId === undefined ? 0 : Number(rawBranchId);

  if (branchId === 0) {
    return authUser.role === "ADMIN" ? undefined : { in: authUser.branchIds };
  }

  if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
    throw new Error("No tienes acceso a la sucursal del comprobante.");
  }

  return branchId;
};

export const getInternalReceipts = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const branchWhere = buildReceiptBranchWhere(req.query.branchId, authUser);
    const receiptType =
      typeof req.query.receiptType === "string"
        ? req.query.receiptType
        : undefined;
    const take = Math.min(Number(req.query.limit || 100), 300);

    const receipts = await prisma.internalReceipt.findMany({
      where: {
        ...(branchWhere === undefined ? {} : { branchId: branchWhere }),
        ...(receiptType ? { receiptType } : {}),
      },
      orderBy: { createdAt: "desc" },
      take,
    });

    res.status(200).json({
      message: "Comprobantes internos recuperados.",
      data: receipts,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo recuperar comprobantes internos.";
    res.status(400).json({ error: errorMsg });
  }
};

export const getInternalReceiptById = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const receiptId = String(req.params.id || "");

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    if (!receiptId) {
      return res.status(400).json({ error: "Falta el ID del comprobante." });
    }

    const receipt = await prisma.internalReceipt.findUnique({
      where: { id: receiptId },
    });

    if (!receipt) {
      return res.status(404).json({ error: "Comprobante no encontrado." });
    }

    if (
      authUser.role !== "ADMIN" &&
      !authUser.branchIds.includes(receipt.branchId)
    ) {
      return res.status(403).json({
        error: "No tienes acceso a la sucursal del comprobante.",
      });
    }

    res.status(200).json({
      message: "Comprobante interno recuperado.",
      data: receipt,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo recuperar el comprobante interno.";
    res.status(400).json({ error: errorMsg });
  }
};

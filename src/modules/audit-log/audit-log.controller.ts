import { Prisma } from "@prisma/client";
import { Response } from "express";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

const parsePositiveInt = (value: unknown) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

export const listAuditLogs = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const branchId = parsePositiveInt(req.query.branchId);
    const actorUserId = parsePositiveInt(req.query.actorUserId);

    if (branchId === null || actorUserId === null) {
      return res.status(400).json({
        error: "Los filtros numericos de auditoria son invalidos.",
      });
    }

    const where: Prisma.AuditLogWhereInput = {
      ...(branchId ? { branchId } : {}),
      ...(actorUserId ? { actorUserId } : {}),
      ...(typeof req.query.action === "string" && req.query.action.trim()
        ? { action: { contains: req.query.action.trim(), mode: "insensitive" } }
        : {}),
      ...(typeof req.query.entityType === "string" &&
      req.query.entityType.trim()
        ? {
            entityType: {
              equals: req.query.entityType.trim(),
              mode: "insensitive",
            },
          }
        : {}),
    };

    const logs = await prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    const actorIds = Array.from(
      new Set(logs.map((log) => log.actorUserId).filter(Boolean)),
    ) as number[];
    const branchIds = Array.from(
      new Set(logs.map((log) => log.branchId).filter(Boolean)),
    ) as number[];
    const [actors, branches] = await Promise.all([
      actorIds.length
        ? prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true, email: true, role: true },
          })
        : Promise.resolve([]),
      branchIds.length
        ? prisma.branch.findMany({
            where: { id: { in: branchIds } },
            select: { id: true, name: true, location: true },
          })
        : Promise.resolve([]),
    ]);
    const actorsById = new Map(actors.map((actor) => [actor.id, actor]));
    const branchesById = new Map(branches.map((branch) => [branch.id, branch]));

    res.status(200).json({
      data: logs.map((log) => ({
        ...log,
        actor: log.actorUserId ? actorsById.get(log.actorUserId) ?? null : null,
        branch: log.branchId ? branchesById.get(log.branchId) ?? null : null,
      })),
      meta: {
        limit,
        count: logs.length,
      },
    });
  } catch (error) {
    console.error("Error al listar auditoria:", error);
    res.status(500).json({ error: "No se pudo obtener la auditoria." });
  }
};

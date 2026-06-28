/**
 * Audit Log Controller — immutable event trail for compliance and debugging.
 *
 * AuditLog entries are written by various controllers (customer, supplier, branch,
 * product, sale, user) to record who did what and when. Entries are never modified
 * or deleted — they are the system's source of truth for change history.
 *
 * @module audit-log.controller
 */
import { Prisma } from "@prisma/client";
import { logger } from '../../config/logger';
import { Response } from "express";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

const parsePositiveInt = (value: unknown) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * GET /audit-logs
 *
 * Returns the most recent audit log entries filtered by branch, actor, action
 * keyword, or entity type. Each entry is enriched with the actor's name/role
 * and the branch name via a secondary lookup (not a JOIN, to keep the response
 * stable even if related records are deleted).
 *
 * Access: ADMIN only.
 *
 * @query branchId    - Optional branch filter.
 * @query actorUserId - Optional: filter by the user who performed the action.
 * @query action      - Optional case-insensitive substring filter on action name.
 * @query entityType  - Optional exact case-insensitive filter on entity type.
 * @query limit       - Max entries to return (default: 50, max: 200).
 */
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
        error: "Los filtros numéricos de auditoría son inválidos.",
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
    const actorsById = new Map(actors.map((actor) => [actor.id, actor] as [typeof actor.id, typeof actor]));
    const branchesById = new Map(branches.map((branch) => [branch.id, branch] as [typeof branch.id, typeof branch]));

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
    logger.error("Error al listar auditoria:", error);
    res.status(500).json({ error: "No se pudo obtener la auditoria." });
  }
};

/**
 * GET /audit-logs/_migrations-diag
 *
 * TEMPORARY read-only diagnostic: returns the Prisma migration bookkeeping rows
 * so we can reconcile a corrupted history on the host without guessing.
 * ADMIN only. Remove once the migration history is reconciled.
 */
export const migrationsDiag = async (_req: AuthRequest, res: Response) => {
  try {
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        migration_name: string;
        finished_at: Date | null;
        rolled_back_at: Date | null;
        applied_steps_count: number;
        started_at: Date | null;
        logs: string | null;
      }>
    >(
      `SELECT migration_name, finished_at, rolled_back_at, applied_steps_count, started_at, logs
       FROM "_prisma_migrations" ORDER BY started_at ASC`,
    );
    res.status(200).json({
      marker: "boot-reconcile-v1",
      data: rows.map((r) => ({
        migration_name: r.migration_name,
        applied: !!r.finished_at && !r.rolled_back_at,
        finished_at: r.finished_at,
        rolled_back_at: r.rolled_back_at,
        applied_steps_count: r.applied_steps_count,
        hasLogs: !!r.logs,
      })),
    });
  } catch (error) {
    logger.error("Error en diagnóstico de migraciones:", error);
    res.status(500).json({ error: "No se pudo leer el estado de migraciones." });
  }
};

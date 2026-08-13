/**
 * Historial de ventas: buscar cualquier operación pasada, con filtros.
 *
 * ── Qué reemplaza ──────────────────────────────────────────────────────────
 *
 * `GET /sales` filtraba por caja o sucursal, topeaba en 500 filas y no aceptaba
 * fechas. En la práctica no servía para lo que el mostrador necesita todos los
 * días: "el ticket de la señora de ayer a la tarde", "qué vendió Fulano esta
 * semana", "esa venta de $80.000 que quedó a cuenta corriente".
 *
 * ── Por qué paginación por CURSOR y no por página ──────────────────────────
 *
 * Con `skip`/`take`, si entra una venta nueva mientras alguien mira la página 2,
 * las filas se corren y aparece repetida la que ya vio (o se saltea una). Con un
 * cursor sobre `(createdAt, id)` cada página arranca exactamente donde terminó
 * la anterior, sin importar lo que haya entrado en el medio.
 *
 * El desempate por `id` no es adorno: dos ventas del mismo segundo tienen el
 * mismo `createdAt`, y sin desempate el cursor podría saltearlas o repetirlas.
 */

import { Response } from "express";

import { Prisma } from "@prisma/client";

import prisma from "../../config/db";
import { logger } from "../../config/logger";
import { capabilitiesForRole } from "../../core/capabilities";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

/** Tope duro por página. Protege al servidor de un `limit=100000`. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

const parseIntOrNull = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

const parseDateOrNull = (value: unknown): Date | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const parseBoolOrNull = (value: unknown): boolean | null => {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
};

/** Lista separada por comas → array de enteros. Ignora la basura en silencio. */
const parseIdList = (value: unknown): number[] => {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
};

/**
 * El cursor es opaco a propósito: `<createdAt ISO>|<id>` en base64url.
 *
 * Si fuera transparente, alguien lo armaría a mano y quedaríamos atados a su
 * formato para siempre. Así podemos cambiarlo sin romper a nadie.
 */
const encodeCursor = (createdAt: Date, id: number): string =>
  Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64url");

const decodeCursor = (raw: unknown): { createdAt: Date; id: number } | null => {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    const fecha = new Date(iso ?? "");
    const numero = Number(id);
    if (Number.isNaN(fecha.getTime()) || !Number.isInteger(numero)) return null;
    return { createdAt: fecha, id: numero };
  } catch {
    return null;
  }
};

/**
 * GET /sales/history
 *
 * Los filtros disponibles, todos opcionales y combinables:
 *
 *   from, to               rango de fechas (por `createdAt`)
 *   branchId               sucursal (o varias, separadas por coma)
 *   terminalId             en qué computadora se hizo
 *   cashRegisterId         turno de caja
 *   sellerId               quién vendió
 *   cashierId              quién cobró
 *   customerId             cliente
 *   consumidorFinal        `true` → sólo ventas SIN cliente asociado
 *   paymentMethod          CASH, DEBIT, CREDIT, TRANSFER, MIXED, CREDIT_ACCOUNT
 *   status                 PAID, PENDING, PARTIAL
 *   kind                   SALE, INTERNAL_CONSUMPTION
 *   excludeInternal        `true` → saca el consumo del personal
 *   minAmount, maxAmount   rango de importe
 *   hasReturns             `true`/`false` → con o sin devoluciones
 *   attributionLegacy      `true` → sólo las de atribución inferida
 *   search                 nº de venta, nombre o documento del cliente, nota
 *   limit, cursor          paginación
 */
export const getSalesHistory = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) {
      return res.status(401).json({ error: "No se pudo validar tu identidad." });
    }

    const q = req.query;

    // ── Alcance por rol ──
    //
    // Un ADMIN ve todo; el resto, sólo sus sucursales. Esto se resuelve en el
    // servidor y NO se puede ensanchar con un parámetro: pedir una sucursal
    // ajena no amplía nada, se intersecta con lo permitido.
    const sucursalesPedidas = parseIdList(q.branchId);
    const branchWhere: Prisma.SaleWhereInput =
      authUser.role === "ADMIN"
        ? sucursalesPedidas.length
          ? { branchId: { in: sucursalesPedidas } }
          : {}
        : {
            branchId: {
              in: sucursalesPedidas.length
                ? sucursalesPedidas.filter((id) => authUser.branchIds.includes(id))
                : authUser.branchIds,
            },
          };

    const from = parseDateOrNull(q.from);
    const to = parseDateOrNull(q.to);
    const minAmount = parseIntOrNull(q.minAmount);
    const maxAmount = parseIntOrNull(q.maxAmount);
    const hasReturns = parseBoolOrNull(q.hasReturns);
    const consumidorFinal = parseBoolOrNull(q.consumidorFinal);
    const attributionLegacy = parseBoolOrNull(q.attributionLegacy);
    const search = typeof q.search === "string" ? q.search.trim() : "";

    // ── Búsqueda libre ──
    // Un cajero busca por lo que tiene a mano: el número del ticket, el nombre
    // del cliente o su documento. Se prueban todos a la vez.
    const searchWhere: Prisma.SaleWhereInput | null = search
      ? {
          OR: [
            ...(Number.isInteger(Number(search)) ? [{ id: Number(search) }] : []),
            { customer: { name: { contains: search, mode: "insensitive" as const } } },
            { customer: { document: { contains: search, mode: "insensitive" as const } } },
            { note: { contains: search, mode: "insensitive" as const } },
            { pickedUpBy: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : null;

    const where: Prisma.SaleWhereInput = {
      ...branchWhere,
      ...(from || to
        ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
      ...(parseIntOrNull(q.terminalId) ? { terminalId: parseIntOrNull(q.terminalId)! } : {}),
      ...(parseIntOrNull(q.cashRegisterId)
        ? { cashRegisterId: parseIntOrNull(q.cashRegisterId)! }
        : {}),
      // La atribución se lee de `sellerId`, con respaldo en `userId` para las
      // ventas anteriores al backfill que pudieran haber quedado sin migrar.
      ...(parseIntOrNull(q.sellerId)
        ? {
            OR: [
              { sellerId: parseIntOrNull(q.sellerId)! },
              { sellerId: null, userId: parseIntOrNull(q.sellerId)! },
            ],
          }
        : {}),
      ...(parseIntOrNull(q.cashierId) ? { cashierId: parseIntOrNull(q.cashierId)! } : {}),
      ...(parseIntOrNull(q.customerId) ? { customerId: parseIntOrNull(q.customerId)! } : {}),
      // Consumidor Final es, literalmente, una venta sin cliente asociado.
      ...(consumidorFinal === true ? { customerId: null } : {}),
      ...(consumidorFinal === false ? { customerId: { not: null } } : {}),
      ...(typeof q.paymentMethod === "string" && q.paymentMethod
        ? { paymentMethod: q.paymentMethod }
        : {}),
      ...(typeof q.status === "string" && q.status ? { status: q.status } : {}),
      ...(typeof q.kind === "string" && q.kind ? { kind: q.kind } : {}),
      ...(parseBoolOrNull(q.excludeInternal) === true
        ? { kind: { not: "INTERNAL_CONSUMPTION" } }
        : {}),
      ...(minAmount !== null || maxAmount !== null
        ? {
            totalAmount: {
              ...(minAmount !== null ? { gte: minAmount } : {}),
              ...(maxAmount !== null ? { lte: maxAmount } : {}),
            },
          }
        : {}),
      ...(hasReturns === true ? { returns: { some: {} } } : {}),
      ...(hasReturns === false ? { returns: { none: {} } } : {}),
      ...(attributionLegacy !== null ? { attributionLegacy } : {}),
      ...(searchWhere ?? {}),
    };

    const limitPedido = parseIntOrNull(q.limit) ?? DEFAULT_PAGE_SIZE;
    const take = Math.min(Math.max(limitPedido, 1), MAX_PAGE_SIZE);
    const cursor = decodeCursor(q.cursor);

    // Se pide UNA fila de más para saber si hay página siguiente sin tener que
    // contar el total, que sobre una tabla grande es caro.
    const filas = await prisma.sale.findMany({
      where: cursor
        ? {
            AND: [
              where,
              {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              },
            ],
          }
        : where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: take + 1,
      // `select` acotado a propósito: sin esto Prisma trae la fila entera de
      // cada relación y el historial de una jornada se vuelve megabytes.
      select: {
        id: true,
        createdAt: true,
        totalAmount: true,
        paymentMethod: true,
        status: true,
        balance: true,
        kind: true,
        note: true,
        attributionLegacy: true,
        sellerId: true,
        cashierId: true,
        sellerNameSnapshot: true,
        cashierNameSnapshot: true,
        userId: true,
        customer: { select: { id: true, name: true, document: true, type: true } },
        branch: { select: { id: true, name: true } },
        terminal: { select: { id: true, code: true } },
        cashRegisterId: true,
        user: { select: { id: true, name: true } },
        _count: { select: { items: true, returns: true } },
      },
    });

    const hayMas = filas.length > take;
    const pagina = hayMas ? filas.slice(0, take) : filas;
    const ultima = pagina[pagina.length - 1];

    res.json({
      data: pagina.map((venta) => ({
        id: venta.id,
        createdAt: venta.createdAt,
        totalAmount: venta.totalAmount,
        paymentMethod: venta.paymentMethod,
        status: venta.status,
        balance: venta.balance,
        kind: venta.kind,
        note: venta.note,
        branch: venta.branch,
        terminal: venta.terminal,
        cashRegisterId: venta.cashRegisterId,
        // Consumidor Final no es un cliente llamado "Consumidor Final": es la
        // AUSENCIA de cliente. Se resuelve acá para que la pantalla no tenga
        // que interpretar un null.
        customer: venta.customer,
        isConsumidorFinal: venta.customer === null,
        itemCount: venta._count.items,
        returnCount: venta._count.returns,
        // El snapshot manda sobre la relación: si a esa persona la renombraron
        // después, el historial sigue diciendo lo que decía el comprobante.
        seller: {
          id: venta.sellerId ?? venta.userId,
          name: venta.sellerNameSnapshot ?? venta.user?.name ?? "—",
        },
        cashier: {
          id: venta.cashierId ?? venta.userId,
          name: venta.cashierNameSnapshot ?? venta.user?.name ?? "—",
        },
        // La pantalla lo muestra como "atribución inferida": nadie observó quién
        // vendió, se dedujo de quién tenía la sesión abierta.
        attributionLegacy: venta.attributionLegacy,
      })),
      pageInfo: {
        hasNextPage: hayMas,
        nextCursor: hayMas && ultima ? encodeCursor(ultima.createdAt, ultima.id) : null,
        pageSize: take,
      },
    });
  } catch (error) {
    logger.error("Error al obtener el historial de ventas:", error);
    res.status(500).json({ error: "No se pudo obtener el historial de ventas." });
  }
};

/**
 * GET /sales/history/filters
 *
 * Las opciones para armar los desplegables: vendedores, terminales y sucursales
 * que el usuario puede ver. Acotado a su alcance, así que un empleado no
 * descubre por acá los nombres del personal de la otra sucursal.
 */
export const getSalesHistoryFilters = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) {
      return res.status(401).json({ error: "No se pudo validar tu identidad." });
    }

    const alcance =
      authUser.role === "ADMIN" ? {} : { id: { in: authUser.branchIds } };

    const [sucursales, terminales, vendedores] = await Promise.all([
      prisma.branch.findMany({
        where: { ...alcance, isActive: true },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.terminal.findMany({
        where:
          authUser.role === "ADMIN" ? {} : { branchId: { in: authUser.branchIds } },
        select: { id: true, code: true, name: true, branchId: true },
        orderBy: { code: "asc" },
      }),
      prisma.user.findMany({
        where:
          authUser.role === "ADMIN"
            ? {}
            : { branches: { some: { id: { in: authUser.branchIds } } } },
        select: { id: true, name: true, role: true },
        orderBy: { name: "asc" },
      }),
    ]);

    res.json({
      data: {
        branches: sucursales,
        terminals: terminales,
        sellers: vendedores,
        paymentMethods: [
          { value: "CASH", label: "Efectivo" },
          { value: "DEBIT", label: "Débito" },
          { value: "CREDIT", label: "Crédito" },
          { value: "TRANSFER", label: "Transferencia" },
          { value: "MIXED", label: "Pago mixto" },
          { value: "CREDIT_ACCOUNT", label: "Cuenta corriente" },
        ],
        statuses: [
          { value: "PAID", label: "Pagada" },
          { value: "PARTIAL", label: "Pago parcial" },
          { value: "PENDING", label: "Pendiente" },
        ],
        kinds: [
          { value: "SALE", label: "Venta" },
          { value: "INTERNAL_CONSUMPTION", label: "Consumo interno" },
        ],
        // Para que la pantalla sepa si mostrar la columna de costo y margen.
        canViewCosts: capabilitiesForRole(authUser.role).has("costs:view"),
      },
    });
  } catch (error) {
    logger.error("Error al obtener las opciones de filtro:", error);
    res.status(500).json({ error: "No se pudieron obtener las opciones." });
  }
};

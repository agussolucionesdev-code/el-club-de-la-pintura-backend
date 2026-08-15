/**
 * Incentivos: planes, reglas, metas, cálculo y liquidación.
 *
 * ── Las cuatro reglas de este archivo ───────────────────────────────────────
 *
 * 1. **Sólo `ELIGIBLE` es plata.** Un asiento `PROVISIONAL` es un pronóstico
 *    para que el vendedor vea lo que tiene en camino. Nunca entra en una
 *    liquidación, nunca llega a un recibo.
 *
 * 2. **Un período aprobado no se recalcula.** Mientras está en DRAFT o
 *    CALCULATED se recalcula entero cuantas veces haga falta — es un borrador.
 *    Desde APPROVED, el número está congelado con la regla que lo produjo.
 *
 * 3. **Lo cobrado tarde se paga tarde, pero se paga.** Un fiado de agosto que
 *    se cobra en octubre genera su asiento elegible en OCTUBRE, arrastrado
 *    automáticamente. Nadie pierde una comisión porque el cliente demoró.
 *
 * 4. **Lo que no se puede evaluar se dice, no se esconde.** Ventas con costo
 *    desconocido o atribución inferida quedan fuera del pago y se informan
 *    aparte con su monto.
 */

import { Response } from "express";

import { Prisma } from "@prisma/client";

import prisma, { type PrismaTx } from "../../config/db";
import { logger } from "../../config/logger";
import { capabilitiesForRole } from "../../core/capabilities";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import {
  assertTransition,
  computeCommission,
  D,
  evaluateMargin,
  IncentiveInvariantError,
  isClosed,
  periodBounds,
  resolvePeriodKey,
  settlementTotals,
  splitEligibility,
  ZERO,
  type Cadence,
  type EligibilityPolicy,
  type PeriodStatus,
  type Rule,
} from "../../utils/incentive.utils";

const manejarError = (res: Response, error: unknown, contexto: string) => {
  if (error instanceof IncentiveInvariantError) {
    logger.warn(`[incentivos] ${contexto}: ${error.message}`);
    return res.status(409).json({ error: error.message, code: "INCENTIVE_INVARIANT" });
  }
  logger.error(`[incentivos] ${contexto}`, error);
  return res.status(500).json({ error: "Error al procesar incentivos" });
};

// ══════════════════════════════════════════════════════════════════════════
// Planes y reglas
// ══════════════════════════════════════════════════════════════════════════

export const listIncentivePlans = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });
    const caps = capabilitiesForRole(authUser.role);
    if (!caps.has("incentives:manage") && !caps.has("incentives:view_all")) {
      return res.status(403).json({ error: "No tenés permiso para ver los planes" });
    }

    const planes = await prisma.incentivePlan.findMany({
      include: {
        rules: { orderBy: { fromAmount: "asc" } },
        _count: { select: { periods: true } },
      },
      orderBy: [{ isActive: "desc" }, { effectiveFrom: "desc" }],
    });

    return res.json({ data: planes });
  } catch (error) {
    return manejarError(res, error, "listIncentivePlans");
  }
};

export const createIncentivePlan = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });
    if (!capabilitiesForRole(authUser.role).has("incentives:manage")) {
      return res.status(403).json({ error: "No tenés permiso para crear planes" });
    }

    const { name, cadence, eligibilityPolicy, minMarginPct, effectiveFrom, rules } =
      req.body as {
        name: string;
        cadence: Cadence;
        eligibilityPolicy: EligibilityPolicy;
        minMarginPct?: number | null;
        effectiveFrom: string;
        rules: {
          kind: Rule["kind"];
          percent?: number | null;
          fromAmount?: number | null;
          toAmount?: number | null;
          fixedAmount?: number | null;
          targetAmount?: number | null;
        }[];
      };

    const desde = new Date(effectiveFrom);

    const plan = await prisma.$transaction(async (tx) => {
      // Un plan nuevo cierra la vigencia del anterior en la misma fecha. Sin
      // esto quedarían dos planes activos y el cálculo tendría que elegir uno,
      // que es exactamente el tipo de ambigüedad que no puede existir cuando el
      // resultado es el sueldo de alguien.
      await tx.incentivePlan.updateMany({
        where: { isActive: true, effectiveTo: null },
        data: { effectiveTo: desde },
      });

      return tx.incentivePlan.create({
        data: {
          name,
          cadence,
          eligibilityPolicy,
          minMarginPct: minMarginPct == null ? null : new Prisma.Decimal(minMarginPct),
          effectiveFrom: desde,
          createdById: authUser.id,
          rules: {
            create: rules.map((r) => ({
              kind: r.kind,
              percent: r.percent == null ? null : new Prisma.Decimal(r.percent),
              fromAmount: r.fromAmount == null ? null : new Prisma.Decimal(r.fromAmount),
              toAmount: r.toAmount == null ? null : new Prisma.Decimal(r.toAmount),
              fixedAmount:
                r.fixedAmount == null ? null : new Prisma.Decimal(r.fixedAmount),
              targetAmount:
                r.targetAmount == null ? null : new Prisma.Decimal(r.targetAmount),
              effectiveFrom: desde,
            })),
          },
        },
        include: { rules: true },
      });
    });

    return res.status(201).json({ message: "Plan creado", data: plan });
  } catch (error) {
    return manejarError(res, error, "createIncentivePlan");
  }
};

// ══════════════════════════════════════════════════════════════════════════
// Cálculo
// ══════════════════════════════════════════════════════════════════════════

/**
 * El cliente de Prisma de este proyecto tiene una extensión que devuelve los
 * `Decimal` como `number`. Por eso los montos se tipan como `Decimal.Value` y
 * se envuelven con `D()` antes de operar: hacer aritmética sobre el `number`
 * crudo reintroduciría el error de punto flotante que todo el resto del sistema
 * evita.
 */
type SaleForIncentive = {
  id: number;
  sellerId: number;
  createdAt: Date;
  totalAmount: Prisma.Decimal.Value;
  balance: Prisma.Decimal.Value;
  status: string;
  attributionLegacy: boolean;
  items: {
    subtotal: Prisma.Decimal.Value;
    quantity: number;
    unitCost: Prisma.Decimal.Value | null;
  }[];
};

/**
 * Ventas que pueden generar comisión.
 *
 * Se excluyen por construcción, no por filtro de la UI:
 * - `kind != "SALE"` → consumo del personal y uso de la empresa. No son ventas
 *   a clientes; pagar comisión por que un empleado se lleve un balde sería
 *   pagarle por gastar.
 * - `status = "CANCELLED"` → la anulación borra el hecho económico.
 */
const buscarVentasDelPeriodo = async (
  tx: PrismaTx,
  desde: Date,
  hasta: Date,
): Promise<SaleForIncentive[]> =>
  tx.sale.findMany({
    where: {
      createdAt: { gte: desde, lt: hasta },
      kind: "SALE",
      status: { not: "CANCELLED" },
    },
    select: {
      id: true,
      sellerId: true,
      createdAt: true,
      totalAmount: true,
      balance: true,
      status: true,
      attributionLegacy: true,
      items: { select: { subtotal: true, quantity: true, unitCost: true } },
    },
    orderBy: { createdAt: "asc" },
  });

/**
 * ¿Esta venta pasa la regla de margen?
 *
 * Si UNA sola línea tiene el costo desconocido, la venta entera queda no
 * evaluable. Calcular el margen con las líneas que sí tienen costo daría un
 * número que parece bueno y no lo es — y nadie sabría después que estaba
 * incompleto.
 */
const evaluarMargenDeVenta = (
  venta: SaleForIncentive,
  minMarginPct: Prisma.Decimal | null,
): { marginKnown: boolean; passes: boolean } => {
  if (minMarginPct === null) return { marginKnown: true, passes: true };

  let ingreso = ZERO;
  let costo = ZERO;
  for (const item of venta.items) {
    if (item.unitCost === null) return { marginKnown: false, passes: false };
    ingreso = ingreso.plus(D(item.subtotal));
    costo = costo.plus(D(item.unitCost).times(item.quantity));
  }

  const veredicto = evaluateMargin({ revenue: ingreso, cost: costo }, minMarginPct);
  return veredicto.computable
    ? { marginKnown: true, passes: veredicto.passes }
    : { marginKnown: false, passes: false };
};

type Asiento = {
  userId: number;
  saleId: number;
  status: "ELIGIBLE" | "PROVISIONAL";
  baseAmount: Prisma.Decimal;
  commissionAmount: Prisma.Decimal;
  ruleSnapshot: Prisma.InputJsonValue;
  marginKnown: boolean;
  reason: string | null;
};

/**
 * Recalcula un período entero, desde cero.
 *
 * Borra y rehace los asientos porque un período en borrador ES un borrador: se
 * recalcula cuantas veces haga falta mientras las reglas o los cobros cambien.
 * Desde `APPROVED` esto se rechaza — ahí el número ya se le mostró a alguien.
 */
export const calculateIncentivePeriod = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });
    if (!capabilitiesForRole(authUser.role).has("incentives:settle")) {
      return res.status(403).json({ error: "No tenés permiso para calcular liquidaciones" });
    }

    const { planId, key } = req.body as { planId: number; key: string };

    const resultado = await prisma.$transaction(
      async (tx) => {
        const plan = await tx.incentivePlan.findUnique({
          where: { id: planId },
          include: { rules: true },
        });
        if (!plan) throw new IncentiveInvariantError(`No existe el plan ${planId}.`);

        const cadencia = plan.cadence as Cadence;
        const { startsAt, endsAt } = periodBounds(key, cadencia);

        let periodo = await tx.incentivePeriod.findUnique({
          where: { planId_key: { planId, key } },
        });
        if (!periodo) {
          periodo = await tx.incentivePeriod.create({
            data: { planId, key, startsAt, endsAt },
          });
        }

        const estado = periodo.status as PeriodStatus;
        if (estado !== "DRAFT" && estado !== "CALCULATED") {
          throw new IncentiveInvariantError(
            `El período ${key} está en ${estado} y ya no se recalcula. ` +
              `Un número aprobado no cambia solo.`,
          );
        }

        // Borrón y cuenta nueva del borrador. Ver el comentario de la función.
        await tx.incentiveLedgerEntry.deleteMany({ where: { periodId: periodo.id } });

        const reglas: Rule[] = plan.rules.map((r) => ({
          id: r.id,
          kind: r.kind,
          percent: r.percent,
          fromAmount: r.fromAmount,
          toAmount: r.toAmount,
          fixedAmount: r.fixedAmount,
          targetAmount: r.targetAmount,
        }));

        const politica = plan.eligibilityPolicy as EligibilityPolicy;
        const minMargen = plan.minMarginPct;

        const ventas = await buscarVentasDelPeriodo(tx, startsAt, endsAt);

        // Cuánto de cada venta YA se volvió elegible en períodos anteriores.
        // Es lo que permite el arrastre: un fiado de agosto cobrado en octubre
        // genera su asiento en octubre sin duplicar el de agosto.
        const yaElegible = new Map<number, Prisma.Decimal>();
        const previos = await tx.incentiveLedgerEntry.groupBy({
          by: ["saleId"],
          where: {
            status: "ELIGIBLE",
            saleId: { not: null },
            periodId: { not: periodo.id },
          },
          _sum: { baseAmount: true },
        });
        for (const fila of previos) {
          if (fila.saleId !== null) {
            yaElegible.set(fila.saleId, D(fila._sum.baseAmount ?? 0));
          }
        }

        const asientos: Asiento[] = [];
        const acumuladoPorVendedor = new Map<number, Prisma.Decimal>();
        let baseInferida = ZERO;
        let baseNoEvaluable = ZERO;

        for (const venta of ventas) {
          const baseTotal = D(venta.totalAmount);
          if (baseTotal.isZero()) continue;

          // Atribución inferida: el backfill dijo "probablemente vendió éste",
          // no lo observó. No se paga comisión sobre una suposición.
          if (venta.attributionLegacy) {
            baseInferida = baseInferida.plus(baseTotal);
            continue;
          }

          const { marginKnown, passes } = evaluarMargenDeVenta(venta, minMargen);
          if (!marginKnown) baseNoEvaluable = baseNoEvaluable.plus(baseTotal);
          if (!marginKnown || !passes) {
            asientos.push({
              userId: venta.sellerId,
              saleId: venta.id,
              status: "PROVISIONAL",
              baseAmount: baseTotal,
              commissionAmount: ZERO,
              ruleSnapshot: {
                excluida: true,
                motivo: marginKnown ? "margen por debajo del mínimo" : "costo desconocido",
              },
              marginKnown,
              reason: marginKnown
                ? "Margen por debajo del mínimo del plan"
                : "Costo desconocido: no se puede evaluar el margen",
            });
            continue;
          }

          const cobrado = baseTotal.minus(D(venta.balance));
          const { eligibleBase, provisionalBase } = splitEligibility(politica, {
            totalBase: baseTotal,
            collectedNow: cobrado,
          });

          // Se descuenta lo que ya se pagó por esta venta en otro período.
          const anterior = yaElegible.get(venta.id) ?? ZERO;
          const nuevoElegible = Prisma.Decimal.max(eligibleBase.minus(anterior), ZERO);

          if (nuevoElegible.greaterThan(0)) {
            const acumulado = acumuladoPorVendedor.get(venta.sellerId) ?? ZERO;
            const comision = computeCommission(reglas, nuevoElegible, acumulado);
            acumuladoPorVendedor.set(venta.sellerId, acumulado.plus(nuevoElegible));
            asientos.push({
              userId: venta.sellerId,
              saleId: venta.id,
              status: "ELIGIBLE",
              baseAmount: nuevoElegible,
              commissionAmount: comision.amount,
              ruleSnapshot: comision.snapshot as Prisma.InputJsonValue,
              marginKnown: true,
              reason: null,
            });
          }

          if (provisionalBase.greaterThan(0)) {
            const acumulado = acumuladoPorVendedor.get(venta.sellerId) ?? ZERO;
            const pronostico = computeCommission(reglas, provisionalBase, acumulado);
            asientos.push({
              userId: venta.sellerId,
              saleId: venta.id,
              status: "PROVISIONAL",
              baseAmount: provisionalBase,
              commissionAmount: pronostico.amount,
              ruleSnapshot: pronostico.snapshot as Prisma.InputJsonValue,
              marginKnown: true,
              reason: "A la espera de que el cliente pague",
            });
          }
        }

        // Arrastre: ventas de períodos ANTERIORES que ya se cobraron.
        const arrastre = await cobrosDeOtrosPeriodos(
          tx,
          startsAt,
          politica,
          reglas,
          acumuladoPorVendedor,
        );
        asientos.push(...arrastre);

        if (asientos.length > 0) {
          await tx.incentiveLedgerEntry.createMany({
            data: asientos.map((a) => ({
              periodId: periodo!.id,
              userId: a.userId,
              saleId: a.saleId,
              status: a.status,
              baseAmount: a.baseAmount,
              commissionAmount: a.commissionAmount,
              ruleSnapshot: a.ruleSnapshot,
              marginKnown: a.marginKnown,
              eligibleAt: a.status === "ELIGIBLE" ? new Date() : null,
              reason: a.reason,
              idempotencyKey: `incentive:${periodo!.id}:${a.saleId}:${a.userId}:${a.status}`,
            })),
          });
        }

        await tx.incentivePeriod.update({
          where: { id: periodo.id },
          data: { status: "CALCULATED", calculatedAt: new Date() },
        });

        return {
          periodId: periodo.id,
          key,
          startsAt,
          endsAt,
          entries: asientos.length,
          salesConsidered: ventas.length,
          carriedOver: arrastre.length,
          inferredAttributionBase: baseInferida.toFixed(2),
          unevaluableBase: baseNoEvaluable.toFixed(2),
        };
      },
      { timeout: 120_000 },
    );

    logger.info(
      `[incentivos] período ${key} calculado: ${resultado.entries} asientos ` +
        `sobre ${resultado.salesConsidered} ventas (${resultado.carriedOver} de arrastre)`,
    );
    return res.json({ message: "Período calculado", data: resultado });
  } catch (error) {
    return manejarError(res, error, "calculateIncentivePeriod");
  }
};

/**
 * Comisiones de ventas viejas que recién ahora se cobraron.
 *
 * Sin esto, un fiado de agosto cobrado en octubre no le pagaría comisión a
 * nadie nunca: en agosto no había entrado la plata y en octubre la venta ya no
 * cae dentro del período. La persona hizo la venta y la perdería por un detalle
 * de implementación.
 *
 * Sólo tiene sentido cuando la política espera el cobro; con `ON_SALE` todo se
 * pagó al vender y no hay nada que arrastrar.
 */
const cobrosDeOtrosPeriodos = async (
  tx: PrismaTx,
  desde: Date,
  politica: EligibilityPolicy,
  reglas: Rule[],
  acumuladoPorVendedor: Map<number, Prisma.Decimal>,
): Promise<Asiento[]> => {
  if (politica === "ON_SALE") return [];

  const pendientes = await tx.incentiveLedgerEntry.findMany({
    where: { status: "PROVISIONAL", saleId: { not: null }, marginKnown: true },
    select: { saleId: true, userId: true, baseAmount: true },
  });
  if (pendientes.length === 0) return [];

  const saleIds = [...new Set(pendientes.map((p) => p.saleId!))];

  const ventas = await tx.sale.findMany({
    where: { id: { in: saleIds }, createdAt: { lt: desde }, status: { not: "CANCELLED" } },
    select: { id: true, sellerId: true, totalAmount: true, balance: true },
  });

  const elegiblePrevio = new Map<number, Prisma.Decimal>();
  const agrupado = await tx.incentiveLedgerEntry.groupBy({
    by: ["saleId"],
    where: { status: "ELIGIBLE", saleId: { in: saleIds } },
    _sum: { baseAmount: true },
  });
  for (const fila of agrupado) {
    if (fila.saleId !== null) {
      elegiblePrevio.set(fila.saleId, D(fila._sum.baseAmount ?? 0));
    }
  }

  const nuevos: Asiento[] = [];
  for (const venta of ventas) {
    const baseTotal = D(venta.totalAmount);
    const cobrado = baseTotal.minus(D(venta.balance));
    const { eligibleBase } = splitEligibility(politica, {
      totalBase: baseTotal,
      collectedNow: cobrado,
    });
    const yaPago = elegiblePrevio.get(venta.id) ?? ZERO;
    const nuevo = eligibleBase.minus(yaPago);
    if (!nuevo.greaterThan(0)) continue;

    const acumulado = acumuladoPorVendedor.get(venta.sellerId) ?? ZERO;
    const comision = computeCommission(reglas, nuevo, acumulado);
    acumuladoPorVendedor.set(venta.sellerId, acumulado.plus(nuevo));
    nuevos.push({
      userId: venta.sellerId,
      saleId: venta.id,
      status: "ELIGIBLE",
      baseAmount: nuevo,
      commissionAmount: comision.amount,
      ruleSnapshot: comision.snapshot as Prisma.InputJsonValue,
      marginKnown: true,
      reason: "Cobro de una venta de un período anterior",
    });
  }

  return nuevos;
};

// ══════════════════════════════════════════════════════════════════════════
// Consulta
// ══════════════════════════════════════════════════════════════════════════

/**
 * Rendimiento del período, con el alcance que corresponde a quien pregunta.
 *
 * Un vendedor ve lo suyo y nada más. Que la comisión de un compañero esté a un
 * clic de distancia es una filtración de información salarial, y ocultarla en
 * el frontend no la protege: se resuelve acá.
 */
export const getPeriodPerformance = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });
    const caps = capabilitiesForRole(authUser.role);

    const verTodo = caps.has("incentives:view_all");
    const verSucursal = caps.has("incentives:view_branch");
    if (!verTodo && !verSucursal && !caps.has("incentives:view_own")) {
      return res.status(403).json({ error: "No tenés permiso para ver incentivos" });
    }

    const { key } = req.params as { key: string };
    const planId = Number(req.query["planId"]);

    const plan = planId
      ? await prisma.incentivePlan.findUnique({ where: { id: planId } })
      : await prisma.incentivePlan.findFirst({
          where: { isActive: true },
          orderBy: { effectiveFrom: "desc" },
        });
    if (!plan) return res.status(404).json({ error: "No hay un plan de incentivos configurado" });

    const periodo = await prisma.incentivePeriod.findUnique({
      where: { planId_key: { planId: plan.id, key } },
    });
    if (!periodo) {
      return res.json({
        data: {
          plan: { id: plan.id, name: plan.name, cadence: plan.cadence },
          period: { key, status: "DRAFT", calculatedAt: null },
          rows: [],
        },
      });
    }

    // Alcance. `view_all` ve todo; `view_branch` ve a los de sus sucursales;
    // el resto, sólo lo propio.
    let userIds: number[] | null = null;
    if (!verTodo) {
      if (verSucursal) {
        const compañeros = await prisma.user.findMany({
          where: { branches: { some: { id: { in: authUser.branchIds } } } },
          select: { id: true },
        });
        userIds = compañeros.map((u) => u.id);
      } else {
        userIds = [authUser.id];
      }
    }

    const asientos = await prisma.incentiveLedgerEntry.findMany({
      where: { periodId: periodo.id, ...(userIds ? { userId: { in: userIds } } : {}) },
      select: {
        userId: true,
        status: true,
        baseAmount: true,
        commissionAmount: true,
        marginKnown: true,
      },
    });

    const metas = await prisma.salesTarget.findMany({
      where: { periodId: periodo.id, ...(userIds ? { userId: { in: userIds } } : {}) },
    });
    const metaPorUsuario = new Map(metas.map((m) => [m.userId, D(m.targetAmount)]));

    const porUsuario = new Map<number, typeof asientos>();
    for (const a of asientos) {
      const lista = porUsuario.get(a.userId) ?? [];
      lista.push(a);
      porUsuario.set(a.userId, lista);
    }

    const usuarios = await prisma.user.findMany({
      where: { id: { in: [...porUsuario.keys()] } },
      select: { id: true, name: true, role: true, avatarUrl: true },
    });
    const nombrePorId = new Map(usuarios.map((u) => [u.id, u]));

    const rows = [...porUsuario.entries()].map(([userId, lista]) => {
      const totales = settlementTotals(
        lista.map((a) => ({
          status: a.status as "PROVISIONAL" | "ELIGIBLE" | "REVERSED",
          commissionAmount: a.commissionAmount,
          marginKnown: a.marginKnown,
          baseAmount: a.baseAmount,
        })),
      );
      const baseElegible = lista
        .filter((a) => a.status === "ELIGIBLE")
        .reduce((acc, a) => acc.plus(D(a.baseAmount)), ZERO);
      const meta = metaPorUsuario.get(userId) ?? null;

      return {
        user: nombrePorId.get(userId) ?? { id: userId, name: "—", role: "", avatarUrl: null },
        soldBase: Number(baseElegible.toFixed(2)),
        payable: Number(totales.payable.toFixed(2)),
        provisional: Number(totales.provisional.toFixed(2)),
        unevaluableBase: Number(totales.unevaluableBase.toFixed(2)),
        target: meta === null ? null : Number(meta.toFixed(2)),
        targetProgressPct:
          meta === null || meta.isZero()
            ? null
            : Number(baseElegible.dividedBy(meta).times(100).toFixed(1)),
      };
    });

    // Se ordena por progreso contra la meta, no por total crudo: dos sucursales
    // con tráfico distinto no compiten en igualdad, y un ranking por facturación
    // pelada premia el local más transitado, no a quien mejor trabajó.
    rows.sort((a, b) => (b.targetProgressPct ?? -1) - (a.targetProgressPct ?? -1));

    return res.json({
      data: {
        plan: {
          id: plan.id,
          name: plan.name,
          cadence: plan.cadence,
          eligibilityPolicy: plan.eligibilityPolicy,
        },
        period: {
          id: periodo.id,
          key: periodo.key,
          status: periodo.status,
          startsAt: periodo.startsAt,
          endsAt: periodo.endsAt,
          calculatedAt: periodo.calculatedAt,
        },
        scope: verTodo ? "ALL" : verSucursal ? "BRANCH" : "OWN",
        rows,
      },
    });
  } catch (error) {
    return manejarError(res, error, "getPeriodPerformance");
  }
};

/** El detalle propio: en qué venta se ganó cada peso y qué está a la espera. */
export const getMyIncentives = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });
    if (!capabilitiesForRole(authUser.role).has("incentives:view_own")) {
      return res.status(403).json({ error: "No tenés permiso para ver incentivos" });
    }

    const planIdPedido = Number(req.query["planId"]);
    const plan = planIdPedido
      ? await prisma.incentivePlan.findUnique({ where: { id: planIdPedido } })
      : await prisma.incentivePlan.findFirst({
          where: { isActive: true },
          orderBy: { effectiveFrom: "desc" },
        });
    if (!plan) return res.json({ data: { plan: null, period: null, entries: [], totals: null } });

    const key =
      (req.query["key"] as string | undefined) ??
      resolvePeriodKey(new Date(), plan.cadence as Cadence);

    const periodo = await prisma.incentivePeriod.findUnique({
      where: { planId_key: { planId: plan.id, key } },
    });
    if (!periodo) {
      return res.json({
        data: { plan: { id: plan.id, name: plan.name }, period: { key }, entries: [], totals: null },
      });
    }

    const asientos = await prisma.incentiveLedgerEntry.findMany({
      where: { periodId: periodo.id, userId: authUser.id },
      select: {
        id: true,
        saleId: true,
        status: true,
        baseAmount: true,
        commissionAmount: true,
        marginKnown: true,
        reason: true,
        eligibleAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });

    const totales = settlementTotals(
      asientos.map((a) => ({
        status: a.status as "PROVISIONAL" | "ELIGIBLE" | "REVERSED",
        commissionAmount: a.commissionAmount,
        marginKnown: a.marginKnown,
        baseAmount: a.baseAmount,
      })),
    );

    return res.json({
      data: {
        plan: { id: plan.id, name: plan.name, cadence: plan.cadence },
        period: { id: periodo.id, key: periodo.key, status: periodo.status },
        entries: asientos,
        totals: {
          payable: Number(totales.payable.toFixed(2)),
          provisional: Number(totales.provisional.toFixed(2)),
          unevaluableBase: Number(totales.unevaluableBase.toFixed(2)),
        },
      },
    });
  } catch (error) {
    return manejarError(res, error, "getMyIncentives");
  }
};

// ══════════════════════════════════════════════════════════════════════════
// Liquidación
// ══════════════════════════════════════════════════════════════════════════

/**
 * Mueve el período por su ciclo de vida y, al pagarlo, alimenta los recibos.
 *
 * El paso a `PAID` es el único que toca plata de verdad: escribe el bono en el
 * `PayrollRecord` del mes. Por eso `IncentiveSettlement.payrollRecordId` es
 * único — sin eso, aprobar dos veces sumaría el bono dos veces al sueldo de
 * alguien, y nadie lo notaría hasta el recibo.
 */
export const transitionPeriod = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });
    if (!capabilitiesForRole(authUser.role).has("incentives:settle")) {
      return res.status(403).json({ error: "No tenés permiso para liquidar incentivos" });
    }

    const periodId = Number(req.params["id"]);
    const { to } = req.body as { to: PeriodStatus };

    const resultado = await prisma.$transaction(async (tx) => {
      const periodo = await tx.incentivePeriod.findUnique({
        where: { id: periodId },
        include: { plan: true },
      });
      if (!periodo) throw new IncentiveInvariantError(`No existe el período ${periodId}.`);

      const desde = periodo.status as PeriodStatus;
      assertTransition(desde, to);

      if (to === "APPROVED") {
        await crearLiquidaciones(tx, periodo.id, authUser.id);
      }
      if (to === "PAID") {
        await imputarEnRecibos(tx, periodo.id, periodo.key, periodo.plan.cadence as Cadence);
      }

      const actualizado = await tx.incentivePeriod.update({
        where: { id: periodId },
        data: {
          status: to,
          ...(to === "APPROVED" ? { approvedById: authUser.id, approvedAt: new Date() } : {}),
          ...(to === "LOCKED" ? { lockedAt: new Date() } : {}),
          ...(to === "PAID" ? { paidAt: new Date() } : {}),
        },
      });

      return { from: desde, to: actualizado.status, periodId };
    });

    logger.info(`[incentivos] período ${periodId}: ${resultado.from} → ${resultado.to}`);
    return res.json({ message: `Período ${resultado.to.toLowerCase()}`, data: resultado });
  } catch (error) {
    return manejarError(res, error, "transitionPeriod");
  }
};

/** Congela el total por persona al aprobar. Sólo `ELIGIBLE` cuenta. */
const crearLiquidaciones = async (tx: PrismaTx, periodId: number, approvedById: number) => {
  const asientos = await tx.incentiveLedgerEntry.findMany({
    where: { periodId },
    select: { userId: true, status: true, commissionAmount: true, marginKnown: true, baseAmount: true },
  });

  const porUsuario = new Map<number, typeof asientos>();
  for (const a of asientos) {
    const lista = porUsuario.get(a.userId) ?? [];
    lista.push(a);
    porUsuario.set(a.userId, lista);
  }

  for (const [userId, lista] of porUsuario) {
    const totales = settlementTotals(
      lista.map((a) => ({
        status: a.status as "PROVISIONAL" | "ELIGIBLE" | "REVERSED",
        commissionAmount: a.commissionAmount,
        marginKnown: a.marginKnown,
        baseAmount: a.baseAmount,
      })),
    );
    if (totales.payable.isZero()) continue;

    // Se verifica el legajo ACÁ y no al pagar.
    //
    // Al pagar, el período ya pasó por LOCKED, y de LOCKED no se vuelve: una
    // persona sin legajo dejaría la liquidación entera trabada sin salida. En
    // la aprobación todavía se puede volver a REVIEWED, cargar el legajo que
    // falta y seguir.
    const legajo = await tx.employee.findFirst({ where: { userId } });
    if (!legajo) {
      throw new IncentiveInvariantError(
        `El usuario ${userId} tiene comisión para cobrar pero no tiene legajo de empleado. ` +
          `Cargale el legajo antes de aprobar: sin legajo no hay recibo donde imputarla.`,
      );
    }

    await tx.incentiveSettlement.upsert({
      where: { periodId_userId: { periodId, userId } },
      create: {
        periodId,
        userId,
        totalAmount: totales.payable,
        approvedById,
        idempotencyKey: `incentive-settlement:${periodId}:${userId}`,
      },
      update: { totalAmount: totales.payable, approvedById, approvedAt: new Date() },
    });
  }
};

/**
 * Imputa cada liquidación al recibo de sueldo del mes.
 *
 * Un período semanal o quincenal cae en el recibo del mes que lo contiene: la
 * comisión se paga junto con el sueldo, aunque se mida más seguido.
 *
 * **Nunca toca un recibo ya pagado.** Si el recibo del mes está en `PAID`, la
 * imputación falla ruidosamente en vez de reescribir un pago hecho.
 */
const imputarEnRecibos = async (
  tx: PrismaTx,
  periodId: number,
  key: string,
  cadencia: Cadence,
) => {
  const liquidaciones = await tx.incentiveSettlement.findMany({
    where: { periodId, payrollRecordId: null },
  });
  if (liquidaciones.length === 0) return;

  const { startsAt } = periodBounds(key, cadencia);
  const mes = resolvePeriodKey(startsAt, "MONTHLY"); // "YYYY-MM", el formato de PayrollRecord

  for (const liq of liquidaciones) {
    // Ya se verificó al aprobar; acá sólo se defiende de que alguien borre el
    // legajo entre la aprobación y el pago.
    const empleado = await tx.employee.findFirst({ where: { userId: liq.userId } });
    if (!empleado) {
      throw new IncentiveInvariantError(
        `El usuario ${liq.userId} tiene comisión aprobada pero ya no tiene legajo. ` +
          `Sin legajo no hay recibo donde imputarla.`,
      );
    }

    const recibo = await tx.payrollRecord.findUnique({
      where: { employeeId_period: { employeeId: empleado.id, period: mes } },
    });

    if (recibo && recibo.status === "PAID") {
      throw new IncentiveInvariantError(
        `El recibo de ${mes} para el legajo ${empleado.id} ya está PAGADO. ` +
          `No se le agrega un bono a un sueldo ya liquidado.`,
      );
    }

    const bonoNuevo = D(recibo?.bonuses ?? 0).plus(D(liq.totalAmount));

    const destino = recibo
      ? await tx.payrollRecord.update({
          where: { id: recibo.id },
          data: {
            bonuses: bonoNuevo,
            netPay: D(recibo.baseSalary)
              .plus(bonoNuevo)
              .minus(D(recibo.advances))
              .minus(D(recibo.deductions)),
          },
        })
      : await tx.payrollRecord.create({
          data: {
            employeeId: empleado.id,
            period: mes,
            baseSalary: 0,
            bonuses: bonoNuevo,
            netPay: bonoNuevo,
            observations: `Comisión del período ${key} (pendiente de cargar el sueldo base)`,
          },
        });

    await tx.incentiveSettlement.update({
      where: { id: liq.id },
      data: { payrollRecordId: destino.id, paidAt: new Date() },
    });
  }
};

// ══════════════════════════════════════════════════════════════════════════
// Metas
// ══════════════════════════════════════════════════════════════════════════

export const setSalesTarget = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });
    if (!capabilitiesForRole(authUser.role).has("incentives:manage")) {
      return res.status(403).json({ error: "No tenés permiso para definir metas" });
    }

    const { periodId, userId, branchId, targetAmount } = req.body as {
      periodId: number;
      userId: number;
      branchId?: number | null;
      targetAmount: number;
    };

    const periodo = await prisma.incentivePeriod.findUnique({ where: { id: periodId } });
    if (!periodo) return res.status(404).json({ error: "No existe el período" });
    if (isClosed(periodo.status as PeriodStatus)) {
      return res.status(409).json({
        error: `El período está ${periodo.status}: no se le cambian las metas después de cerrado`,
      });
    }

    const meta = await prisma.salesTarget.upsert({
      where: { periodId_userId: { periodId, userId } },
      create: {
        periodId,
        userId,
        branchId: branchId ?? null,
        targetAmount: new Prisma.Decimal(targetAmount),
      },
      update: {
        branchId: branchId ?? null,
        targetAmount: new Prisma.Decimal(targetAmount),
      },
    });

    return res.json({ message: "Meta definida", data: meta });
  } catch (error) {
    return manejarError(res, error, "setSalesTarget");
  }
};

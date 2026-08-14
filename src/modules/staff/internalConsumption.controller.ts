/**
 * Consumo interno: lo que se lleva un empleado vs. lo que usa la empresa.
 *
 * ── Por qué son dos cosas y no una ──────────────────────────────────────────
 *
 * Hoy las dos se registran igual: una venta ordinaria a un `Customer` de tipo
 * INTERNAL creado escribiendo un nombre a mano. Pero no tienen nada que ver:
 *
 *   · El empleado que se lleva un pincel **DEBE** ese pincel.
 *   · El rollo de cinta que la empresa usa para pintar su propio local es un
 *     **COSTO del negocio**, y no lo debe nadie.
 *
 * Mezclarlas hace dos daños a la vez: infla la facturación con plata que nunca
 * entró, y deja la deuda del personal sin registrar en ningún lado consultable.
 *
 * ── Lo que las dos comparten ────────────────────────────────────────────────
 *
 * Las dos **descuentan stock de verdad**, con la misma guarda atómica que una
 * venta. La mercadería salió del depósito, y el inventario tiene que decir la
 * verdad sin importar por qué salió.
 */

import { Response } from "express";

import { Prisma } from "@prisma/client";

import prisma, { type PrismaTx } from "../../config/db";
import { logger } from "../../config/logger";
import { capabilitiesForRole } from "../../core/capabilities";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { userBranchScope, withIdempotency } from "../../utils/idempotency.utils";
import {
  LedgerInvariantError,
  resolveInternalPrice,
  type PricePolicy,
} from "../../utils/staffLedger.utils";
import { decrementStockOrThrow, InsufficientStockError } from "../../utils/stock.utils";

type ItemEntrada = {
  productId: number;
  quantity: number;
  explicitPrice?: number | null;
};

/**
 * POST /internal-consumptions
 *
 * Registra que salió mercadería del depósito sin una venta detrás.
 */
export const createInternalConsumption = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const caps = capabilitiesForRole(authUser.role);
    if (!caps.has("staff:consume")) {
      return res.status(403).json({
        error: "No tenés permiso para registrar consumo interno.",
        code: "CAPABILITY_DENIED",
      });
    }

    const {
      kind,
      branchId,
      cashRegisterId,
      userId,
      purpose,
      pricePolicy,
      pricePolicyRate,
      items,
      reason,
    } = req.body as {
      kind: "EMPLOYEE_PERSONAL" | "COMPANY_USE";
      branchId: number;
      cashRegisterId?: number | null;
      userId?: number | null;
      purpose?: string | null;
      pricePolicy: PricePolicy;
      pricePolicyRate?: number | null;
      items: ItemEntrada[];
      reason?: string | null;
    };

    // ── Quién puede elegir una política que no sea la de lista ──
    //
    // Cobrarse a uno mismo al costo es, en los hechos, un descuento que nadie
    // autorizó. Las políticas que se apartan del precio de lista exigen
    // capacidad de aprobación.
    const POLITICAS_QUE_REQUIEREN_APROBACION: PricePolicy[] = [
      "COST",
      "COST_PLUS",
      "STAFF_DISCOUNT",
      "EXPLICIT",
    ];
    if (
      POLITICAS_QUE_REQUIEREN_APROBACION.includes(pricePolicy) &&
      !caps.has("staff:approve")
    ) {
      return res.status(403).json({
        error:
          "Esa política de precio necesita autorización de un encargado. " +
          "Podés registrarlo a precio de lista.",
        code: "CAPABILITY_DENIED",
      });
    }

    // Un empleado sólo se carga a SÍ MISMO. Cargarle mercadería a otro es, sin
    // más vueltas, generarle una deuda que no pidió.
    if (
      kind === "EMPLOYEE_PERSONAL" &&
      Number(userId) !== authUser.id &&
      !caps.has("staff:approve")
    ) {
      return res.status(403).json({
        error: "Sólo podés registrar consumo a tu propia cuenta.",
        code: "CAPABILITY_DENIED",
      });
    }

    const clave =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"].trim()
        : "";

    const ejecutar = async (tx: PrismaTx) => {
      // ── Cuenta del personal: se crea al primer consumo ──
      //
      // No se crean por adelantado para todos: una cuenta sin un solo asiento
      // es ruido en el tablero. La tiene quien se llevó algo alguna vez.
      let staffAccountId: number | null = null;
      if (kind === "EMPLOYEE_PERSONAL") {
        const cuenta = await tx.staffAccount.upsert({
          where: { userId: Number(userId) },
          create: { userId: Number(userId) },
          update: {},
        });
        staffAccountId = cuenta.id;
      }

      // ── Precios: SIEMPRE desde la base ──
      //
      // Misma regla que una venta (Fase 2): el navegador no decide cuánto vale
      // nada. Acá importa igual o más, porque el "cliente" es quien tipea.
      const productos = await tx.product.findMany({
        where: { id: { in: items.map((i) => Number(i.productId)) } },
        select: { id: true, name: true, sku: true, retailPrice: true, costPrice: true },
      });
      const porId = new Map(productos.map((p) => [p.id, p]));

      let total = new Prisma.Decimal(0);
      let costoTotal = new Prisma.Decimal(0);
      const lineas: Prisma.InternalConsumptionItemCreateManyConsumptionInput[] = [];

      for (const item of items) {
        const producto = porId.get(Number(item.productId));
        if (!producto) {
          throw new LedgerInvariantError(
            `El producto ${item.productId} no existe en el catálogo.`,
          );
        }

        const lista = producto.retailPrice ?? new Prisma.Decimal(0);
        const unitario = resolveInternalPrice({
          policy: pricePolicy,
          rate: pricePolicyRate ?? null,
          listPrice: lista,
          costPrice: producto.costPrice,
          explicitPrice: item.explicitPrice ?? null,
        });

        const cantidad = Number(item.quantity);
        const subtotal = unitario.times(cantidad);
        total = total.plus(subtotal);

        // `unitCost` NULL cuando se desconoce, nunca 0 (regla de la Fase 2).
        // Un costo inventado contamina el margen para siempre.
        if (producto.costPrice != null) {
          // `new Prisma.Decimal(...)` explícito: el cliente extendido de este
          // proyecto convierte algunos Decimal a `number` al leerlos, así que
          // no se puede asumir que venga con métodos de Decimal.
          costoTotal = costoTotal.plus(
            new Prisma.Decimal(producto.costPrice).times(cantidad),
          );
        }

        lineas.push({
          productId: producto.id,
          quantity: cantidad,
          listPrice: lista,
          unitPrice: unitario,
          unitCost: producto.costPrice,
          subtotal,
        });

        // La misma guarda atómica que una venta: la condición viaja en el
        // WHERE, no en un `if` de JavaScript.
        await decrementStockOrThrow(
          tx,
          { productId: producto.id, branchId: Number(branchId) },
          cantidad,
        );

        await tx.movement.create({
          data: {
            type: "OUT",
            quantity: cantidad,
            reason:
              kind === "EMPLOYEE_PERSONAL"
                ? "Consumo del personal"
                : `Uso de la empresa: ${purpose}`,
            productId: producto.id,
            branchId: Number(branchId),
            userId: authUser.id,
          },
        });
      }

      const consumo = await tx.internalConsumption.create({
        data: {
          kind,
          branchId: Number(branchId),
          cashRegisterId: cashRegisterId ? Number(cashRegisterId) : null,
          staffAccountId,
          purpose: kind === "COMPANY_USE" ? purpose : null,
          pricePolicy,
          pricePolicyRate: pricePolicyRate ?? null,
          totalAmount: total,
          totalCost: costoTotal,
          createdById: authUser.id,
          authorizedById: caps.has("staff:approve") ? authUser.id : null,
          reason: reason ?? null,
          items: { createMany: { data: lineas } },
        },
      });

      // ── El asiento: SÓLO si hay un deudor ──
      //
      // Acá se ve la diferencia entera entre las dos clases. El uso de la
      // empresa descuenta stock y registra su costo, pero **no genera deuda de
      // nadie**: no hay a quién cobrarle.
      if (kind === "EMPLOYEE_PERSONAL" && staffAccountId !== null) {
        await tx.staffLedgerEntry.create({
          data: {
            staffAccountId,
            type: "CONSUMPTION",
            debit: total,
            credit: 0,
            sourceType: "InternalConsumption",
            sourceId: consumo.id,
            reason:
              reason ??
              `Consumo del personal (${lineas.length} ${lineas.length === 1 ? "ítem" : "ítems"})`,
            createdById: authUser.id,
            metadata: {
              pricePolicy,
              pricePolicyRate: pricePolicyRate ?? null,
              items: lineas.map((l) => ({
                productId: l.productId,
                quantity: l.quantity,
                unitPrice: String(l.unitPrice),
              })),
            },
          },
        });
      }

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: Number(branchId),
          action:
            kind === "EMPLOYEE_PERSONAL"
              ? "INTERNAL_CONSUMPTION_STAFF"
              : "INTERNAL_CONSUMPTION_COMPANY",
          entityType: "InternalConsumption",
          entityId: String(consumo.id),
          metadata: {
            kind,
            total: total.toFixed(2),
            pricePolicy,
            staffAccountId,
            purpose: purpose ?? null,
          },
        },
      });

      return {
        id: consumo.id,
        kind,
        totalAmount: total.toNumber(),
        totalCost: costoTotal.toNumber(),
        // Que la respuesta lo diga explícitamente evita que la pantalla tenga
        // que deducir si esto generó deuda o no.
        createdDebt: kind === "EMPLOYEE_PERSONAL",
        staffAccountId,
      };
    };

    if (!clave) {
      logger.warn(
        `[IDEMPOTENCIA] Consumo interno sin Idempotency-Key (usuario ${authUser.id}).`,
      );
      const resultado = await prisma.$transaction(ejecutar);
      return res.status(201).json({ message: mensaje(resultado.kind), data: resultado });
    }

    const outcome = await withIdempotency(
      {
        key: clave,
        payload: req.body,
        scope: userBranchScope(authUser.id, Number(branchId)),
      },
      async (tx) => {
        const value = await ejecutar(tx);
        return {
          value,
          resultType: "internal-consumption",
          resultId: String(value.id),
          httpStatus: 201,
        };
      },
    );

    if (outcome.kind === "conflict") {
      return res.status(409).json({ error: outcome.message, code: outcome.code });
    }
    if (outcome.kind === "replayed") {
      return res.status(200).json({
        message: "Este consumo ya estaba registrado.",
        data: { id: Number(outcome.resultId) },
        replayed: true,
      });
    }

    res.status(201).json({ message: mensaje(outcome.value.kind), data: outcome.value });
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      return res.status(409).json({ error: error.message, code: "INSUFFICIENT_STOCK" });
    }
    if (error instanceof LedgerInvariantError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    logger.error("Error al registrar consumo interno:", error);
    res.status(500).json({ error: "No se pudo registrar el consumo." });
  }
};

const mensaje = (kind: string) =>
  kind === "EMPLOYEE_PERSONAL"
    ? "Consumo registrado y cargado a la cuenta del personal."
    : "Uso de la empresa registrado. No genera deuda de nadie.";

/**
 * GET /internal-consumptions
 *
 * Historial. Se puede filtrar por clase, que es lo que permite responder por
 * separado "cuánto se llevó el personal" y "cuánto gastó la empresa en sí
 * misma" — dos preguntas que hoy tienen la misma respuesta contaminada.
 */
export const listInternalConsumptions = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const caps = capabilitiesForRole(authUser.role);
    const kind = typeof req.query.kind === "string" ? req.query.kind : null;

    // Quien sólo puede ver lo suyo, ve lo suyo: ni los consumos de sus
    // compañeros ni los de la empresa.
    const puedeVerTodo = caps.has("staff:view_all") || caps.has("staff:view_branch");
    const propia = await prisma.staffAccount.findUnique({
      where: { userId: authUser.id },
      select: { id: true },
    });

    const where: Prisma.InternalConsumptionWhereInput = {
      ...(kind ? { kind: kind as "EMPLOYEE_PERSONAL" | "COMPANY_USE" } : {}),
      ...(puedeVerTodo
        ? caps.has("staff:view_all")
          ? {}
          : { branchId: { in: authUser.branchIds } }
        : { staffAccountId: propia?.id ?? -1 }),
    };

    const consumos = await prisma.internalConsumption.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(req.query.limit) || 50, 200),
      include: {
        staffAccount: { include: { user: { select: { id: true, name: true } } } },
        items: { select: { productId: true, quantity: true, subtotal: true } },
      },
    });

    res.json({
      data: consumos.map((c) => ({
        id: c.id,
        kind: c.kind,
        createdAt: c.createdAt,
        branchId: c.branchId,
        totalAmount: c.totalAmount.toNumber(),
        // El costo sólo para quien puede verlo, y omitido del payload —
        // no escondido en la pantalla (misma regla que el detalle de venta).
        ...(caps.has("costs:view") ? { totalCost: c.totalCost.toNumber() } : {}),
        pricePolicy: c.pricePolicy,
        purpose: c.purpose,
        beneficiary: c.staffAccount?.user ?? null,
        itemCount: c.items.length,
      })),
    });
  } catch (error) {
    logger.error("Error al listar consumos internos:", error);
    res.status(500).json({ error: "No se pudieron obtener los consumos." });
  }
};

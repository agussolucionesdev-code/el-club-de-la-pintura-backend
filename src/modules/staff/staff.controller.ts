/**
 * Cuentas del personal: saldos, extracto, pagos y ajustes.
 *
 * ── Las tres reglas de este archivo ─────────────────────────────────────────
 *
 * 1. **El libro es inmutable.** Nada se edita ni se borra. Un error se corrige
 *    con un asiento compensatorio que apunta al original. Un saldo editable no
 *    es un saldo: es una opinión.
 *
 * 2. **Sólo el efectivo toca la caja física.** Un pago por transferencia, un
 *    descuento de haberes o una condonación bajan la deuda pero no ponen un
 *    peso en el cajón. Meterlos al arqueo haría que la caja nunca cierre.
 *
 * 3. **Cada uno ve lo suyo.** Un empleado no tiene por qué saber cuánto debe su
 *    compañero. Se resuelve en el servidor, no ocultando una columna.
 */

import { Response } from "express";

import { Prisma } from "@prisma/client";

import prisma, { type PrismaTx } from "../../config/db";
import { logger } from "../../config/logger";
import { capabilitiesForRole } from "../../core/capabilities";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { withIdempotency, userBranchScope } from "../../utils/idempotency.utils";
import {
  computeStaffBalance,
  LedgerInvariantError,
} from "../../utils/staffLedger.utils";
import { CASH_IN } from "../../utils/cashMovement.utils";

/** Tipos de asiento que son CRÉDITO. El signo lo decide el tipo, no quien carga. */
const CREDIT_TYPES = new Set([
  "PAYMENT",
  "PAYROLL_DEDUCTION",
  "RETURN_CREDIT",
  "TRANSFER_REVERSAL",
  "ADJUSTMENT_CREDIT",
]);

const METHOD_TO_ENTRY = {
  CASH: "PAYMENT",
  TRANSFER: "PAYMENT",
  PAYROLL_DEDUCTION: "PAYROLL_DEDUCTION",
  MERCHANDISE_RETURN: "RETURN_CREDIT",
  WRITE_OFF: "ADJUSTMENT_CREDIT",
} as const;

/**
 * Qué cuentas puede ver quien pregunta.
 *
 * Devuelve `null` cuando no puede ver ninguna que no sea la propia — y en ese
 * caso el filtro se arma por `userId`, no por sucursal.
 */
const alcanceDeLectura = async (authUser: { id: number; role: string; branchIds: number[] }) => {
  const caps = capabilitiesForRole(authUser.role);
  if (caps.has("staff:view_all")) return { tipo: "TODAS" as const };
  if (caps.has("staff:view_branch")) {
    return { tipo: "SUCURSAL" as const, branchIds: authUser.branchIds };
  }
  return { tipo: "PROPIA" as const, userId: authUser.id };
};

/**
 * GET /staff-accounts
 *
 * El tablero de cuánto debe el personal. Un empleado que entra acá se ve a sí
 * mismo y a nadie más.
 */
export const listStaffAccounts = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const alcance = await alcanceDeLectura(authUser);

    const where: Prisma.StaffAccountWhereInput =
      alcance.tipo === "TODAS"
        ? {}
        : alcance.tipo === "SUCURSAL"
          ? { user: { branches: { some: { id: { in: alcance.branchIds } } } } }
          : { userId: alcance.userId };

    const cuentas = await prisma.staffAccount.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, role: true, avatarUrl: true } },
        // Se traen los asientos y se suma acá en vez de guardar un total
        // denormalizado: un saldo guardado aparte es un segundo lugar donde la
        // verdad puede estar mal, y con decenas de asientos por persona el
        // costo es irrelevante.
        entries: { select: { debit: true, credit: true } },
      },
      orderBy: { user: { name: "asc" } },
    });

    const data = cuentas.map((cuenta) => {
      const saldo = computeStaffBalance(cuenta.entries);
      return {
        id: cuenta.id,
        user: cuenta.user,
        balance: saldo.toNumber(),
        creditLimit: cuenta.creditLimit?.toNumber() ?? null,
        // Se informa, no se bloquea: que alguien no pueda llevarse un pincel un
        // viernes porque pasó el tope por $200 es peor remedio que la enfermedad.
        overLimit:
          cuenta.creditLimit != null && saldo.greaterThan(cuenta.creditLimit),
        entryCount: cuenta.entries.length,
        isActive: cuenta.isActive,
      };
    });

    res.json({
      data,
      summary: {
        totalOwed: data.reduce((s, c) => s + Math.max(c.balance, 0), 0),
        accountsWithDebt: data.filter((c) => c.balance > 0).length,
        scope: alcance.tipo,
      },
    });
  } catch (error) {
    logger.error("Error al listar cuentas del personal:", error);
    res.status(500).json({ error: "No se pudieron obtener las cuentas." });
  }
};

/** Verifica que quien pregunta pueda ver ESTA cuenta. */
const puedeVerCuenta = async (
  authUser: { id: number; role: string; branchIds: number[] },
  staffAccountId: number,
) => {
  const cuenta = await prisma.staffAccount.findUnique({
    where: { id: staffAccountId },
    include: {
      user: {
        select: { id: true, name: true, role: true, branches: { select: { id: true } } },
      },
    },
  });
  if (!cuenta) return { cuenta: null, permitido: false };

  const caps = capabilitiesForRole(authUser.role);
  const permitido =
    caps.has("staff:view_all") ||
    cuenta.userId === authUser.id ||
    (caps.has("staff:view_branch") &&
      cuenta.user.branches.some((b) => authUser.branchIds.includes(b.id)));

  return { cuenta, permitido };
};

/**
 * GET /staff-accounts/:id/ledger
 *
 * El extracto: qué se llevó, qué pagó y qué le corrigieron. Es lo que una
 * persona necesita ver para poder discutir su saldo — y poder discutirlo es
 * exactamente el punto.
 */
export const getStaffLedger = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const id = Number(req.params.id);
    const { cuenta, permitido } = await puedeVerCuenta(authUser, id);

    if (!cuenta) return res.status(404).json({ error: "La cuenta no existe." });
    if (!permitido) {
      return res.status(403).json({ error: "No podés ver esta cuenta." });
    }

    const desde = req.query.from ? new Date(String(req.query.from)) : null;
    const hasta = req.query.to ? new Date(String(req.query.to)) : null;

    /**
     * Qué movimientos mostrar.
     *
     * "Cargos" y "Pagos" no son tipos de la base: son las dos preguntas que la
     * gente hace de verdad —"qué me cobraron" y "qué pagué"—, y se traducen a
     * los tipos que corresponden. Filtrar por el nombre técnico del asiento
     * sería obligar al usuario a aprenderse el esquema.
     */
    const tipo = String(req.query.tipo ?? "TODOS");
    const CARGOS = ["OPENING_BALANCE", "CONSUMPTION", "ADJUSTMENT_DEBIT"];
    const PAGOS = [
      "PAYMENT",
      "PAYROLL_DEDUCTION",
      "RETURN_CREDIT",
      "TRANSFER_REVERSAL",
      "ADJUSTMENT_CREDIT",
    ];
    const filtroDeTipo =
      tipo === "TODOS"
        ? {}
        : tipo === "CARGOS"
          ? { type: { in: CARGOS as never[] } }
          : tipo === "PAGOS"
            ? { type: { in: PAGOS as never[] } }
            : { type: tipo as never };

    const asientos = await prisma.staffLedgerEntry.findMany({
      where: {
        staffAccountId: id,
        ...filtroDeTipo,
        ...(desde || hasta
          ? {
              createdAt: {
                ...(desde && !Number.isNaN(desde.getTime()) ? { gte: desde } : {}),
                ...(hasta && !Number.isNaN(hasta.getTime()) ? { lte: hasta } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: Number(req.query.limit) || 100,
    });

    // El saldo se calcula sobre TODOS los asientos, no sobre los filtrados: si
    // no, filtrar por fecha mostraría un saldo que no es el que la persona debe.
    const todos = await prisma.staffLedgerEntry.findMany({
      where: { staffAccountId: id },
      select: { debit: true, credit: true },
    });

    /**
     * Quién registró cada asiento.
     *
     * `createdById` estaba en la base desde el principio y no viajaba en la
     * respuesta. Un libro donde no se sabe quién anotó cada cosa no es
     * auditable: es una lista de números que alguien puso ahí.
     */
    const autores = await prisma.user.findMany({
      where: { id: { in: [...new Set(asientos.map((a) => a.createdById))] } },
      select: { id: true, name: true },
    });
    const nombrePorId = new Map(autores.map((u) => [u.id, u.name]));

    /**
     * El detalle de lo que originó el asiento.
     *
     * Un cargo que dice "Se llevó mercadería · $12.000" no se puede discutir:
     * para reclamar o para reconocer hay que saber QUÉ se llevó. El vínculo ya
     * existía (`sourceType` + `sourceId`), pero nadie lo resolvía, así que el
     * dato estaba guardado y era invisible.
     *
     * Se resuelve en DOS consultas para toda la página, no una por fila: con
     * doscientos movimientos, lo segundo son doscientos viajes a la base para
     * pintar una tabla.
     */
    const idsConsumo = asientos
      .filter((a) => a.sourceType === "InternalConsumption" && a.sourceId)
      .map((a) => a.sourceId as number);
    const idsPago = asientos
      .filter((a) => a.sourceType === "StaffPaymentSettlement" && a.sourceId)
      .map((a) => a.sourceId as number);

    const [consumos, pagos] = await Promise.all([
      idsConsumo.length
        ? prisma.internalConsumption.findMany({
            where: { id: { in: idsConsumo } },
            select: {
              id: true,
              kind: true,
              purpose: true,
              pricePolicy: true,
              branchId: true,
              // `InternalConsumptionItem` no tiene relación con Product:
              // guarda el id suelto. Los nombres se resuelven abajo, en una
              // sola consulta para todos los productos de la página.
              items: {
                select: {
                  productId: true,
                  quantity: true,
                  unitPrice: true,
                  subtotal: true,
                },
              },
            },
          })
        : Promise.resolve([]),
      idsPago.length
        ? prisma.staffPaymentSettlement.findMany({
            where: { id: { in: idsPago } },
            select: {
              id: true,
              method: true,
              reference: true,
              cashRegisterId: true,
              branchId: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const consumoPorId = new Map(consumos.map((c) => [c.id, c] as const));
    const pagoPorId = new Map(pagos.map((p) => [p.id, p] as const));

    // Nombres de productos y sucursales, en dos consultas para toda la página.
    const idsProducto = [
      ...new Set(consumos.flatMap((c) => c.items.map((i) => i.productId))),
    ];
    const idsSucursal = [
      ...new Set(
        [...pagos.map((p) => p.branchId), ...consumos.map((c) => c.branchId)].filter(
          (b): b is number => !!b,
        ),
      ),
    ];
    const [productos, sucursales] = await Promise.all([
      idsProducto.length
        ? prisma.product.findMany({
            where: { id: { in: idsProducto } },
            select: { id: true, name: true, sku: true },
          })
        : Promise.resolve([]),
      idsSucursal.length
        ? prisma.branch.findMany({
            where: { id: { in: idsSucursal } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const productoPorId = new Map(productos.map((p) => [p.id, p] as const));
    const sucursalPorId = new Map(sucursales.map((b) => [b.id, b.name] as const));

    /** El detalle que corresponde a este asiento, o `null` si no tiene. */
    const detalleDe = (a: (typeof asientos)[number]) => {
      if (a.sourceType === "InternalConsumption" && a.sourceId) {
        const c = consumoPorId.get(a.sourceId);
        if (!c) return null;
        return {
          clase: "CONSUMO" as const,
          sucursal: c.branchId ? (sucursalPorId.get(c.branchId) ?? null) : null,
          politicaDePrecio: c.pricePolicy,
          proposito: c.purpose,
          items: c.items.map((i) => {
            const prod = productoPorId.get(i.productId);
            return {
              productoId: i.productId,
              // Si el producto se borró del catálogo, se muestra el id crudo:
              // feo, pero honesto. Un guion escondería que ahí hubo algo.
              nombre: prod?.name ?? `Producto #${i.productId}`,
              sku: prod?.sku ?? null,
              cantidad: i.quantity,
              precioUnitario: i.unitPrice.toNumber(),
              subtotal: i.subtotal.toNumber(),
            };
          }),
        };
      }
      if (a.sourceType === "StaffPaymentSettlement" && a.sourceId) {
        const p = pagoPorId.get(a.sourceId);
        if (!p) return null;
        return {
          clase: "PAGO" as const,
          metodo: p.method,
          referencia: p.reference,
          sucursal: p.branchId ? (sucursalPorId.get(p.branchId) ?? null) : null,
          turno: p.cashRegisterId,
        };
      }
      return null;
    };

    res.json({
      data: {
        account: {
          id: cuenta.id,
          user: { id: cuenta.user.id, name: cuenta.user.name, role: cuenta.user.role },
          balance: computeStaffBalance(todos).toNumber(),
          creditLimit: cuenta.creditLimit?.toNumber() ?? null,
        },
        entries: asientos.map((a) => ({
          id: a.id,
          type: a.type,
          debit: a.debit.toNumber(),
          credit: a.credit.toNumber(),
          reason: a.reason,
          sourceType: a.sourceType,
          sourceId: a.sourceId,
          // Que se vea qué asiento corrige a cuál: es la diferencia entre un
          // libro auditable y una lista de números.
          reversalOfId: a.reversalOfId,
          /** Quién lo registró. Sin esto el libro no es auditable. */
          registradoPor: nombrePorId.get(a.createdById) ?? null,
          /** Qué se llevó, o cómo pagó. `null` si el asiento no tiene origen. */
          detalle: detalleDe(a),
          createdAt: a.createdAt,
        })),
      },
    });
  } catch (error) {
    logger.error("Error al obtener el extracto:", error);
    res.status(500).json({ error: "No se pudo obtener el extracto." });
  }
};

/**
 * POST /staff-accounts/:id/payments
 *
 * Registra que alguien saldó (total o parcialmente) lo que debía.
 *
 * **Sólo `CASH` genera movimiento de caja.** Es la corrección que ordena todo
 * este endpoint: un descuento de haberes baja la deuda pero no pone un peso en
 * el cajón, y meterlo al arqueo haría que la caja nunca cierre.
 */
export const createStaffPayment = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const staffAccountId = Number(req.params.id);
    const { method, amount, cashRegisterId, reference, reason } = req.body as {
      method: keyof typeof METHOD_TO_ENTRY;
      amount: number;
      cashRegisterId?: number | null;
      reference?: string | null;
      reason?: string | null;
    };

    const caps = capabilitiesForRole(authUser.role);

    // Condonar es regalar plata de la empresa: exige capacidad de ajuste, no
    // alcanza con poder cobrar.
    if (method === "WRITE_OFF" && !caps.has("staff:adjust")) {
      return res.status(403).json({
        error: "No tenés permiso para condonar deudas del personal.",
        code: "CAPABILITY_DENIED",
      });
    }

    const cuenta = await prisma.staffAccount.findUnique({
      where: { id: staffAccountId },
      include: { user: { select: { name: true } } },
    });
    if (!cuenta) return res.status(404).json({ error: "La cuenta no existe." });

    const clave =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"].trim()
        : "";

    const ejecutar = async (tx: PrismaTx) => {
      // ── Efectivo: y sólo efectivo ──
      let branchId: number | null = null;
      if (method === "CASH") {
        const caja = await tx.cashRegister.findUnique({
          where: { id: Number(cashRegisterId) },
        });
        if (!caja) throw new LedgerInvariantError("La caja indicada no existe.");
        if (caja.status !== "OPEN") {
          throw new LedgerInvariantError(
            "La caja está cerrada. Un pago en efectivo tiene que entrar a un turno abierto.",
          );
        }
        branchId = caja.branchId;
      }

      const liquidacion = await tx.staffPaymentSettlement.create({
        data: {
          staffAccountId,
          method,
          amount,
          cashRegisterId: method === "CASH" ? Number(cashRegisterId) : null,
          branchId,
          reference: reference ?? null,
          createdById: authUser.id,
          authorizedById: method === "WRITE_OFF" ? authUser.id : null,
          reason: reason ?? null,
        },
      });

      const tipo = METHOD_TO_ENTRY[method];

      await tx.staffLedgerEntry.create({
        data: {
          staffAccountId,
          type: tipo,
          // Todos estos son CRÉDITO: bajan lo que la persona debe.
          debit: 0,
          credit: amount,
          sourceType: "StaffPaymentSettlement",
          sourceId: liquidacion.id,
          reason:
            reason ??
            (method === "CASH"
              ? "Pago en efectivo"
              : method === "TRANSFER"
                ? "Pago por transferencia"
                : method === "PAYROLL_DEDUCTION"
                  ? "Descuento de haberes"
                  : method === "MERCHANDISE_RETURN"
                    ? "Devolución de mercadería"
                    : "Condonación"),
          createdById: authUser.id,
          authorizedById: method === "WRITE_OFF" ? authUser.id : null,
        },
      });

      // ── El movimiento de caja, sólo si hubo plata física ──
      if (method === "CASH" && branchId !== null) {
        await tx.cashMovement.create({
          data: {
            // La constante, no el string. Acá decía "INCOME" —un valor que el
            // módulo de caja no reconoce— así que esta plata entraba al cajón
            // sin entrar al arqueo, y el turno cerraba con sobrante.
            type: CASH_IN,
            amount,
            // Con el nombre adentro, el arqueo se puede leer sin abrir otra
            // pantalla: "Cobro a Fulano" dice todo lo que hace falta saber.
            reason: `Cobro a ${cuenta.user.name} (cuenta del personal)`,
            branchId,
            cashRegisterId: Number(cashRegisterId),
            userId: authUser.id,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId,
          action: "STAFF_PAYMENT_REGISTERED",
          entityType: "StaffPaymentSettlement",
          entityId: String(liquidacion.id),
          metadata: { method, amount, staffAccountId, target: cuenta.user.name },
        },
      });

      const asientos = await tx.staffLedgerEntry.findMany({
        where: { staffAccountId },
        select: { debit: true, credit: true },
      });

      return {
        settlementId: liquidacion.id,
        newBalance: computeStaffBalance(asientos).toNumber(),
        affectedCashRegister: method === "CASH",
      };
    };

    // Toda mutación de plata va bajo clave de idempotencia. Sin clave se acepta
    // durante la transición, igual que en ventas, pero queda registrado.
    if (!clave) {
      logger.warn(
        `[IDEMPOTENCIA] Pago de personal sin Idempotency-Key (usuario ${authUser.id}).`,
      );
      const resultado = await prisma.$transaction(ejecutar);
      return res.status(201).json({ message: mensajePago(method), data: resultado });
    }

    const outcome = await withIdempotency(
      { key: clave, payload: req.body, scope: userBranchScope(authUser.id, 0) },
      async (tx) => {
        const value = await ejecutar(tx);
        return { value, resultType: "staff-payment", resultId: String(value.settlementId), httpStatus: 201 };
      },
    );

    if (outcome.kind === "conflict") {
      return res.status(409).json({ error: outcome.message, code: outcome.code });
    }
    if (outcome.kind === "replayed") {
      return res.status(200).json({
        message: "Este pago ya estaba registrado.",
        data: { settlementId: Number(outcome.resultId) },
        replayed: true,
      });
    }

    res.status(201).json({ message: mensajePago(method), data: outcome.value });
  } catch (error) {
    if (error instanceof LedgerInvariantError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    logger.error("Error al registrar el pago del personal:", error);
    res.status(500).json({ error: "No se pudo registrar el pago." });
  }
};

const mensajePago = (method: string) =>
  method === "CASH"
    ? "Pago registrado y sumado a la caja."
    : method === "WRITE_OFF"
      ? "Deuda condonada. Queda el asiento con el motivo."
      : "Pago registrado. No afecta la caja física.";

/**
 * POST /staff-accounts/:id/adjustments
 *
 * Corrige un saldo — y lo hace AGREGANDO un asiento, nunca editando.
 *
 * Que el ajuste quede a la vista en el extracto es el punto: si se pudiera
 * corregir en silencio, el saldo dejaría de ser algo que la persona pueda
 * discutir.
 */
export const createStaffAdjustment = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    if (!capabilitiesForRole(authUser.role).has("staff:adjust")) {
      return res.status(403).json({
        error: "No tenés permiso para ajustar cuentas del personal.",
        code: "CAPABILITY_DENIED",
      });
    }

    const staffAccountId = Number(req.params.id);
    const { direction, amount, reason } = req.body as {
      direction: "DEBIT" | "CREDIT";
      amount: number;
      reason: string;
    };

    const cuenta = await prisma.staffAccount.findUnique({
      where: { id: staffAccountId },
    });
    if (!cuenta) return res.status(404).json({ error: "La cuenta no existe." });

    const tipo = direction === "DEBIT" ? "ADJUSTMENT_DEBIT" : "ADJUSTMENT_CREDIT";

    const resultado = await prisma.$transaction(async (tx) => {
      const asiento = await tx.staffLedgerEntry.create({
        data: {
          staffAccountId,
          type: tipo,
          debit: direction === "DEBIT" ? amount : 0,
          credit: direction === "CREDIT" ? amount : 0,
          reason,
          createdById: authUser.id,
          // Quien ajusta también autoriza: es una acción que ya exige la
          // capacidad, y fingir una segunda firma que no existe sería peor.
          authorizedById: authUser.id,
        },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          action: "STAFF_ACCOUNT_ADJUSTED",
          entityType: "StaffLedgerEntry",
          entityId: String(asiento.id),
          metadata: { staffAccountId, direction, amount, reason },
        },
      });

      const asientos = await tx.staffLedgerEntry.findMany({
        where: { staffAccountId },
        select: { debit: true, credit: true },
      });

      return { entryId: asiento.id, newBalance: computeStaffBalance(asientos).toNumber() };
    });

    res.status(201).json({
      message: "Ajuste registrado. Queda visible en el extracto con su motivo.",
      data: resultado,
    });
  } catch (error) {
    logger.error("Error al ajustar la cuenta del personal:", error);
    res.status(500).json({ error: "No se pudo registrar el ajuste." });
  }
};

/** GET /staff-accounts/me — atajo para ver lo propio sin buscar el id. */
export const getMyStaffAccount = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    const cuenta = await prisma.staffAccount.findUnique({
      where: { userId: authUser.id },
      include: { entries: { select: { debit: true, credit: true } } },
    });

    if (!cuenta) {
      // No tener cuenta no es un error: es no haberse llevado nada nunca.
      return res.json({ data: { exists: false, balance: 0 } });
    }

    res.json({
      data: {
        exists: true,
        id: cuenta.id,
        balance: computeStaffBalance(cuenta.entries).toNumber(),
        creditLimit: cuenta.creditLimit?.toNumber() ?? null,
      },
    });
  } catch (error) {
    logger.error("Error al obtener la cuenta propia:", error);
    res.status(500).json({ error: "No se pudo obtener tu cuenta." });
  }
};

export { CREDIT_TYPES };

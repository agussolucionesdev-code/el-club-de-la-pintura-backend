/**
 * Traslado de cuentas internas legado al libro del personal.
 *
 * ── Qué es esto y por qué existe ────────────────────────────────────────────
 *
 * El sistema viejo registraba el consumo del personal como una venta a cuenta
 * corriente de un `Customer` de tipo INTERNAL, creado escribiendo un nombre a
 * mano. Esas deudas existen, son reales, y hoy están mezcladas con las de los
 * clientes de verdad. Trasladarlas es sacarlas de Cuentas Corrientes y ponerlas
 * donde corresponde: el libro de esa persona.
 *
 * ── Las dos correcciones que ordenan este archivo ───────────────────────────
 *
 * **1. NO SE FALSIFICA EL HISTÓRICO.** Mi primera propuesta ponía
 * `status = "PAID"` y `balance = 0` en las ventas trasladadas. Eso declara
 * cobrada una operación que nunca se cobró. Acá el estado, el saldo, los pagos
 * y las devoluciones quedan **intactos**: sólo se anota cuánto se trasladó, en
 * columnas nuevas. La venta se muestra "Trasladada al libro del personal",
 * jamás "Pagada".
 *
 * **2. UN TRASLADO REVERTIDO SE PUEDE REHACER.** Con `saleId @unique` —mi
 * segunda versión— la base habría rechazado el segundo traslado. Ahora cada
 * traslado es un CICLO numerado; el revertido queda archivado e inmutable y
 * sale del índice de ciclo vivo.
 *
 * ── La regla que hace que esto sea seguro ───────────────────────────────────
 *
 * Se mide el total ANTES, se traslada, se mide DESPUÉS. **Si la suma de las dos
 * puntas no es idéntica, la transacción entera se revierte.** No se confía en
 * que la aritmética esté bien: se verifica contra la base, adentro de la misma
 * transacción, antes de committear.
 */

import { Response } from "express";

import { Prisma } from "@prisma/client";

import prisma, { type PrismaTx } from "../../config/db";
import { logger } from "../../config/logger";
import { capabilitiesForRole } from "../../core/capabilities";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import {
  activeReceivable,
  assertTransferInvariants,
  LedgerInvariantError,
  resolveCycleStatus,
} from "../../utils/staffLedger.utils";

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

/**
 * GET /legacy-links
 *
 * La pantalla de reconciliación: cada `Customer` de tipo INTERNAL con su saldo
 * real y su vínculo, si ya tiene.
 *
 * **No propone ningún vínculo por parecido de nombre.** Que "Juan P." y "juan
 * perez" sean la misma persona lo sabe alguien que trabaja ahí, no un
 * algoritmo de similitud — y equivocarse acá significa cobrarle a la persona
 * equivocada.
 */
export const listLegacyCandidates = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    if (!capabilitiesForRole(authUser.role).has("staff:transfer_legacy")) {
      return res.status(403).json({
        error: "No tenés permiso para trasladar cuentas legado.",
        code: "CAPABILITY_DENIED",
      });
    }

    const internos = await prisma.customer.findMany({
      where: { type: "INTERNAL" },
      include: {
        sales: {
          where: { status: { in: ["PENDING", "PARTIAL"] } },
          select: {
            id: true,
            createdAt: true,
            totalAmount: true,
            balance: true,
            status: true,
            transferredToStaffLedger: true,
            transferReversed: true,
          },
        },
      },
      orderBy: { name: "asc" },
    });

    const vinculos = await prisma.staffAccountLegacyLink.findMany({
      include: { staffAccount: { include: { user: { select: { id: true, name: true } } } } },
    });
    const porCliente = new Map(vinculos.map((v) => [v.legacyCustomerId, v]));

    const data = internos.map((cliente) => {
      const pendiente = cliente.sales.reduce(
        (suma, venta) => suma.plus(activeReceivable(venta)),
        new Prisma.Decimal(0),
      );
      const yaTrasladado = cliente.sales.reduce(
        (suma, venta) =>
          suma.plus(D(venta.transferredToStaffLedger)).minus(D(venta.transferReversed)),
        new Prisma.Decimal(0),
      );
      const vinculo = porCliente.get(cliente.id);

      return {
        legacyCustomerId: cliente.id,
        name: cliente.name,
        isActive: cliente.isActive,
        saleCount: cliente.sales.length,
        /** Lo que TODAVÍA es cuenta corriente: la porción sin trasladar. */
        pendingBalance: pendiente.toNumber(),
        alreadyTransferred: yaTrasladado.toNumber(),
        link: vinculo
          ? {
              id: vinculo.id,
              status: vinculo.status,
              staffAccountId: vinculo.staffAccountId,
              user: vinculo.staffAccount.user,
              transferredTotal: vinculo.transferredTotal?.toNumber() ?? null,
            }
          : null,
      };
    });

    res.json({
      data,
      summary: {
        totalPending: data.reduce((s, c) => s + c.pendingBalance, 0),
        unlinked: data.filter((c) => !c.link).length,
      },
    });
  } catch (error) {
    logger.error("Error al listar candidatos legado:", error);
    res.status(500).json({ error: "No se pudieron obtener las cuentas legado." });
  }
};

/**
 * POST /legacy-links
 *
 * Propone el vínculo. **No traslada nada todavía**: crea el `PROPOSED` para que
 * alguien pueda revisarlo antes de mover plata.
 *
 * Separar proponer de ejecutar no es burocracia: es que la decisión de a quién
 * se le cobra una deuda vieja se pueda mirar dos veces.
 */
export const proposeLegacyLink = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    if (!capabilitiesForRole(authUser.role).has("staff:transfer_legacy")) {
      return res.status(403).json({ error: "No tenés permiso.", code: "CAPABILITY_DENIED" });
    }

    const { legacyCustomerId, userId, reason } = req.body as {
      legacyCustomerId: number;
      userId: number;
      reason: string;
    };

    const [cliente, usuario] = await Promise.all([
      prisma.customer.findUnique({ where: { id: Number(legacyCustomerId) } }),
      prisma.user.findUnique({ where: { id: Number(userId) } }),
    ]);

    if (!cliente || cliente.type !== "INTERNAL") {
      return res.status(400).json({
        error: "Esa cuenta no es una cuenta interna del sistema viejo.",
      });
    }
    if (!usuario) return res.status(404).json({ error: "El usuario no existe." });

    const existente = await prisma.staffAccountLegacyLink.findUnique({
      where: { legacyCustomerId: Number(legacyCustomerId) },
    });
    if (existente && existente.status === "CONFIRMED") {
      return res.status(409).json({
        error: "Esa cuenta legado ya fue trasladada. Para rehacerla, revertí el traslado.",
      });
    }

    const cuenta = await prisma.staffAccount.upsert({
      where: { userId: Number(userId) },
      create: { userId: Number(userId) },
      update: {},
    });

    const vinculo = existente
      ? await prisma.staffAccountLegacyLink.update({
          where: { id: existente.id },
          data: { staffAccountId: cuenta.id, status: "PROPOSED", reason },
        })
      : await prisma.staffAccountLegacyLink.create({
          data: {
            staffAccountId: cuenta.id,
            legacyCustomerId: Number(legacyCustomerId),
            status: "PROPOSED",
            reason,
            proposedById: authUser.id,
          },
        });

    res.status(201).json({
      message:
        `Vínculo propuesto: "${cliente.name}" → ${usuario.name}. ` +
        "Todavía no se trasladó nada; revisalo y confirmalo.",
      data: { id: vinculo.id, status: vinculo.status },
    });
  } catch (error) {
    logger.error("Error al proponer vínculo legado:", error);
    res.status(500).json({ error: "No se pudo proponer el vínculo." });
  }
};

/**
 * POST /legacy-links/:id/confirm
 *
 * **Acá se mueve la plata.** Una sola transacción que:
 *
 *   1. Mide la deuda vigente ANTES.
 *   2. Crea un ciclo de traslado por cada venta con saldo.
 *   3. Anota el acumulado en cada venta, **sin tocar status ni balance**.
 *   4. Crea UN asiento de apertura en el libro, con el desglose por venta.
 *   5. Desactiva la cuenta legado para que no reaparezca en el selector.
 *   6. Mide DESPUÉS y **verifica que las dos puntas den lo mismo**.
 *
 * Si el paso 6 no cierra, se revierte todo. La aritmética no se da por buena:
 * se comprueba contra la base antes de committear.
 */
export const confirmLegacyTransfer = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    if (!capabilitiesForRole(authUser.role).has("staff:transfer_legacy")) {
      return res.status(403).json({ error: "No tenés permiso.", code: "CAPABILITY_DENIED" });
    }

    const linkId = Number(req.params.id);
    const { reason } = req.body as { reason: string };

    const resultado = await prisma.$transaction(async (tx: PrismaTx) => {
      const vinculo = await tx.staffAccountLegacyLink.findUnique({
        where: { id: linkId },
        include: {
          staffAccount: { include: { user: { select: { id: true, name: true } } } },
        },
      });

      if (!vinculo) throw new LedgerInvariantError("El vínculo no existe.");
      if (vinculo.status === "CONFIRMED") {
        throw new LedgerInvariantError("Este vínculo ya fue trasladado.");
      }

      const cliente = await tx.customer.findUnique({
        where: { id: vinculo.legacyCustomerId },
      });
      if (!cliente) throw new LedgerInvariantError("La cuenta legado no existe.");

      // ── 1. MEDICIÓN PREVIA ──
      const ventas = await tx.sale.findMany({
        where: {
          customerId: vinculo.legacyCustomerId,
          status: { in: ["PENDING", "PARTIAL"] },
        },
        select: {
          id: true,
          status: true,
          balance: true,
          totalAmount: true,
          transferredToStaffLedger: true,
          transferReversed: true,
        },
      });

      const deudaAntes = ventas.reduce(
        (s, v) => s.plus(activeReceivable(v)),
        new Prisma.Decimal(0),
      );

      if (deudaAntes.lessThanOrEqualTo(0)) {
        throw new LedgerInvariantError(
          `"${cliente.name}" no tiene deuda pendiente para trasladar.`,
        );
      }

      const asientosAntes = await tx.staffLedgerEntry.findMany({
        where: { staffAccountId: vinculo.staffAccountId },
        select: { debit: true, credit: true },
      });

      // ── Número de RONDA de traslado ──
      //
      // La clave de idempotencia no puede ser sólo el vínculo: un vínculo se
      // puede trasladar, revertir y volver a trasladar, y la segunda vez
      // chocaría contra su propia clave única. (Pasó: el test de re-traslado
      // devolvía 500.)
      //
      // Con la ronda adentro, la clave sigue cumpliendo su función —dos envíos
      // concurrentes de ESTE traslado colisionan y sólo uno pasa— sin bloquear
      // un traslado legítimamente nuevo.
      const rondasPrevias = await tx.staffLedgerEntry.count({
        where: {
          staffAccountId: vinculo.staffAccountId,
          type: "OPENING_BALANCE",
          sourceType: "StaffAccountLegacyLink",
          sourceId: vinculo.id,
        },
      });
      const ronda = rondasPrevias + 1;
      const saldoLibroAntes = asientosAntes.reduce(
        (s, a) => s.plus(D(a.debit)).minus(D(a.credit)),
        new Prisma.Decimal(0),
      );

      // ── 2 y 3. Un ciclo por venta ──
      const desglose: { saleId: number; amount: string; cycle: number }[] = [];
      let totalTrasladado = new Prisma.Decimal(0);

      for (const venta of ventas) {
        const aTrasladar = activeReceivable(venta);
        if (aTrasladar.lessThanOrEqualTo(0)) continue;

        // El número de ciclo sale del máximo previo. Un ciclo cerrado no
        // estorba: salió del índice parcial de ciclo vivo.
        const previos = await tx.legacySaleTransfer.findMany({
          where: { saleId: venta.id },
          orderBy: { cycleNumber: "desc" },
          take: 1,
        });
        const cycleNumber = (previos[0]?.cycleNumber ?? 0) + 1;

        await tx.legacySaleTransfer.create({
          data: {
            legacyLinkId: vinculo.id,
            saleId: venta.id,
            cycleNumber,
            // Se PRESERVAN: son el histórico real de la venta y nunca se tocan.
            originalStatus: venta.status,
            originalBalance: venta.balance,
            transferredAmount: aTrasladar,
            status: "ACTIVE",
          },
        });

        await tx.sale.update({
          where: { id: venta.id },
          data: {
            // Acumulado, no reemplazo: puede haber ciclos anteriores cerrados.
            transferredToStaffLedger: { increment: aTrasladar },
            // ⚠️ `status` y `balance` NO se tocan. Ésa es la corrección entera.
          },
        });

        desglose.push({
          saleId: venta.id,
          amount: aTrasladar.toFixed(2),
          cycle: cycleNumber,
        });
        totalTrasladado = totalTrasladado.plus(aTrasladar);
      }

      // ── 4. UN asiento de apertura, con el desglose adentro ──
      //
      // Uno solo y no uno por venta: el libro tiene que leerse como "el saldo
      // que traías", no como veinte líneas que nadie va a revisar. El detalle
      // vive en la metadata, inmutable.
      const asiento = await tx.staffLedgerEntry.create({
        data: {
          staffAccountId: vinculo.staffAccountId,
          type: "OPENING_BALANCE",
          debit: totalTrasladado,
          credit: 0,
          sourceType: "StaffAccountLegacyLink",
          sourceId: vinculo.id,
          reason,
          createdById: authUser.id,
          // Trasladar deuda de una persona exige una firma explícita.
          authorizedById: authUser.id,
          metadata: {
            legacyCustomerId: cliente.id,
            legacyCustomerName: cliente.name,
            sales: desglose,
          },
          // Idempotencia permanente: aunque el IdempotencyRecord se perdiera,
          // el índice único de esta columna rechaza un segundo envío de ESTA
          // ronda. La ronda va adentro para no bloquear un re-traslado
          // legítimo después de una reversión.
          idempotencyKey: `legacy-transfer:${vinculo.id}:${ronda}`,
        },
      });

      // ── 5. Fuera del selector ──
      await tx.customer.update({
        where: { id: cliente.id },
        data: { isActive: false },
      });

      await tx.staffAccountLegacyLink.update({
        where: { id: vinculo.id },
        data: {
          status: "CONFIRMED",
          confirmedById: authUser.id,
          confirmedAt: new Date(),
          transferredTotal: totalTrasladado,
        },
      });

      // ── 6. MEDICIÓN POSTERIOR: las dos puntas tienen que dar lo mismo ──
      const ventasDespues = await tx.sale.findMany({
        where: {
          customerId: vinculo.legacyCustomerId,
          status: { in: ["PENDING", "PARTIAL"] },
        },
        select: {
          balance: true,
          transferredToStaffLedger: true,
          transferReversed: true,
        },
      });
      const deudaDespues = ventasDespues.reduce(
        (s, v) => s.plus(activeReceivable(v)),
        new Prisma.Decimal(0),
      );

      const asientosDespues = await tx.staffLedgerEntry.findMany({
        where: { staffAccountId: vinculo.staffAccountId },
        select: { debit: true, credit: true },
      });
      const saldoLibroDespues = asientosDespues.reduce(
        (s, a) => s.plus(D(a.debit)).minus(D(a.credit)),
        new Prisma.Decimal(0),
      );

      // La plata no aparece ni desaparece: lo que sale de Cuentas Corrientes
      // tiene que entrar al libro, peso por peso.
      const bajaCuentaCorriente = deudaAntes.minus(deudaDespues);
      const subeLibro = saldoLibroDespues.minus(saldoLibroAntes);

      if (!bajaCuentaCorriente.equals(subeLibro)) {
        throw new LedgerInvariantError(
          `La reconciliación no cierra: Cuentas Corrientes bajó ` +
            `${bajaCuentaCorriente.toFixed(2)} pero el libro subió ${subeLibro.toFixed(2)}. ` +
            "No se trasladó nada.",
        );
      }
      if (!bajaCuentaCorriente.equals(totalTrasladado)) {
        throw new LedgerInvariantError(
          `La reconciliación no cierra contra lo trasladado ` +
            `(${totalTrasladado.toFixed(2)}). No se trasladó nada.`,
        );
      }

      // Invariantes por venta, ya con los valores escritos.
      for (const venta of ventas) {
        const actualizada = await tx.sale.findUnique({
          where: { id: venta.id },
          select: {
            balance: true,
            transferredToStaffLedger: true,
            transferReversed: true,
          },
        });
        const ciclos = await tx.legacySaleTransfer.findMany({
          where: { saleId: venta.id },
          select: { transferredAmount: true, reversedAmount: true },
        });
        assertTransferInvariants(actualizada!, ciclos);
      }

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          action: "LEGACY_ACCOUNT_TRANSFERRED",
          entityType: "StaffAccountLegacyLink",
          entityId: String(vinculo.id),
          metadata: {
            legacyCustomerName: cliente.name,
            targetUser: vinculo.staffAccount.user.name,
            total: totalTrasladado.toFixed(2),
            salesAffected: desglose.length,
            reason,
          },
        },
      });

      return {
        linkId: vinculo.id,
        entryId: asiento.id,
        transferredTotal: totalTrasladado.toNumber(),
        salesAffected: desglose.length,
        targetUser: vinculo.staffAccount.user,
        reconciled: true,
      };
    });

    res.json({
      message:
        `Se trasladaron $${resultado.transferredTotal.toLocaleString("es-AR")} de ` +
        `${resultado.salesAffected} operaciones a la cuenta de ${resultado.targetUser.name}. ` +
        "Las ventas conservan su estado original y se muestran como trasladadas.",
      data: resultado,
    });
  } catch (error) {
    if (error instanceof LedgerInvariantError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    logger.error("Error al confirmar el traslado legado:", error);
    res.status(500).json({ error: "No se pudo completar el traslado." });
  }
};

/**
 * POST /legacy-links/:id/reverse
 *
 * Deshace un traslado — **sólo con asientos compensatorios**.
 *
 * Nada se borra ni se edita. El asiento de apertura queda donde está, y se
 * agrega uno de `TRANSFER_REVERSAL` que apunta a él. Los ciclos quedan
 * marcados `FULLY_REVERSED`, salen del índice de ciclo vivo, y la venta puede
 * volver a trasladarse en un ciclo nuevo si hiciera falta.
 */
export const reverseLegacyTransfer = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "Sesión inválida." });

    if (!capabilitiesForRole(authUser.role).has("staff:adjust")) {
      return res.status(403).json({
        error: "Revertir un traslado exige permiso de ajuste.",
        code: "CAPABILITY_DENIED",
      });
    }

    const linkId = Number(req.params.id);
    const { reason } = req.body as { reason: string };

    const resultado = await prisma.$transaction(async (tx: PrismaTx) => {
      const vinculo = await tx.staffAccountLegacyLink.findUnique({
        where: { id: linkId },
        include: { transfers: true },
      });

      if (!vinculo) throw new LedgerInvariantError("El vínculo no existe.");
      if (vinculo.status !== "CONFIRMED") {
        throw new LedgerInvariantError("Este vínculo no tiene un traslado que revertir.");
      }

      const apertura = await tx.staffLedgerEntry.findFirst({
        where: {
          staffAccountId: vinculo.staffAccountId,
          type: "OPENING_BALANCE",
          sourceType: "StaffAccountLegacyLink",
          sourceId: vinculo.id,
        },
      });
      if (!apertura) {
        throw new LedgerInvariantError("No se encontró el asiento de apertura a revertir.");
      }

      let totalRevertido = new Prisma.Decimal(0);

      for (const ciclo of vinculo.transfers) {
        const vivo = D(ciclo.transferredAmount).minus(D(ciclo.reversedAmount));
        if (vivo.lessThanOrEqualTo(0)) continue;

        await tx.legacySaleTransfer.update({
          where: { id: ciclo.id },
          data: {
            reversedAmount: { increment: vivo },
            // El estado se DERIVA de los montos, no se elige.
            status: resolveCycleStatus({
              transferredAmount: ciclo.transferredAmount,
              reversedAmount: D(ciclo.reversedAmount).plus(vivo),
            }),
          },
        });

        await tx.sale.update({
          where: { id: ciclo.saleId },
          data: { transferReversed: { increment: vivo } },
        });

        totalRevertido = totalRevertido.plus(vivo);
      }

      // El asiento de apertura NO se toca. Se agrega su compensación.
      const compensacion = await tx.staffLedgerEntry.create({
        data: {
          staffAccountId: vinculo.staffAccountId,
          type: "TRANSFER_REVERSAL",
          debit: 0,
          credit: totalRevertido,
          sourceType: "StaffAccountLegacyLink",
          sourceId: vinculo.id,
          reversalOfId: apertura.id,
          reason,
          createdById: authUser.id,
          authorizedById: authUser.id,
        },
      });

      // La cuenta legado vuelve a estar disponible: la deuda es suya otra vez.
      await tx.customer.update({
        where: { id: vinculo.legacyCustomerId },
        data: { isActive: true },
      });

      await tx.staffAccountLegacyLink.update({
        where: { id: vinculo.id },
        data: { status: "PROPOSED", transferredTotal: null },
      });

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          action: "LEGACY_TRANSFER_REVERSED",
          entityType: "StaffAccountLegacyLink",
          entityId: String(vinculo.id),
          metadata: { total: totalRevertido.toFixed(2), reason },
        },
      });

      return {
        reversedTotal: totalRevertido.toNumber(),
        compensatingEntryId: compensacion.id,
        openingEntryId: apertura.id,
      };
    });

    res.json({
      message:
        `Traslado revertido por $${resultado.reversedTotal.toLocaleString("es-AR")}. ` +
        "El asiento original queda en el libro con su contra-asiento al lado.",
      data: resultado,
    });
  } catch (error) {
    if (error instanceof LedgerInvariantError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    logger.error("Error al revertir el traslado legado:", error);
    res.status(500).json({ error: "No se pudo revertir el traslado." });
  }
};

/**
 * Sale Controller — point-of-sale transaction lifecycle.
 *
 * Core responsibilities:
 * - Create sales (cash, card, bank transfer, accounts-receivable / "fiado")
 * - Cancel sales with stock restitution
 * - Retrieve sales list and individual sale details
 * - Generate PDF receipt for a completed sale
 * - Expose pending receivables (open accounts) and export them to Excel
 *
 * Business rules:
 * - Sales require an OPEN cash-register shift for the target branch.
 * - Accounts-receivable sales (`paymentMethod: CUENTA_CORRIENTE`) require a customer.
 * - Stock is decremented atomically per branch inside a Prisma transaction.
 * - An internal receipt is created for every confirmed sale.
 *
 * @module sale.controller
 */
import { createHmac, randomBytes } from "node:crypto";
import { Response } from "express";
import { Payment } from "@prisma/client";
import { logger } from '../../config/logger';
import PDFDocument from "pdfkit";
import * as ExcelJS from "exceljs";
import prisma, { type PrismaTx } from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";
import { readSettings } from "../settings/settings.controller";
import {
  decrementStockOrThrow,
  isUniqueConstraintViolation,
} from "../../utils/stock.utils";
import {
  IDEMPOTENCY_KEY_PATTERN,
  userBranchScope,
  withIdempotency,
} from "../../utils/idempotency.utils";
import {
  assertTotalMatches,
  priceSaleLines,
  resolveCashChange,
  toDecimal,
  TotalMismatchError,
} from "../../utils/pricing.utils";
import {
  resolveTerminalIfAvailable,
  TerminalResolutionError,
} from "../../utils/terminal.utils";
import {
  IdentityMismatchError,
  resolveSaleAttribution,
  resolveSaleKind,
} from "../../utils/attribution.utils";
import { PosContextError, resolvePosContext } from "../../core/pos-context";
import { capabilitiesForRole } from "../../core/capabilities";

class SaleBranchAccessError extends Error {}
class SaleNotFoundError extends Error {}

const responseStatusForSaleError = (error: unknown) => {
  if (error instanceof SaleBranchAccessError) return 403;
  if (error instanceof SaleNotFoundError) return 404;
  return 400;
};

const parsePositiveInt = (value: unknown, fieldName: string) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} invalido.`);
  }

  return parsed;
};

const formatMoney = (amount: number) =>
  `$ ${amount.toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatReceiptDate = (date: Date) =>
  date.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: "America/Argentina/Buenos_Aires",
  });

const parseCancellationReason = (value: unknown) => {
  if (typeof value !== "string" || value.trim().length < 5) {
    throw new Error("Debe indicar un motivo de anulacion claro.");
  }

  return value.trim().slice(0, 500);
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

// ────────────────────────────────────────────────────────────────────────────
// Ticket-discount authorization code (supervisor override, supermarket style)
// ────────────────────────────────────────────────────────────────────────────
// A 6-digit code derived from the server secret, per branch, per day (Argentina
// time). ADMIN/ENCARGADO can read it and hand it to the cashier; EMPLOYEE must
// type it to apply a whole-ticket discount. Deterministic — nothing to store,
// rotates automatically at midnight.
const dailyDiscountCode = (branchId: number): string => {
  const day = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
  const digest = createHmac("sha256", process.env.JWT_SECRET ?? "")
    .update(`ticket-discount:${branchId}:${day}`)
    .digest("hex");
  return String(parseInt(digest.slice(0, 8), 16) % 1_000_000).padStart(6, "0");
};

/**
 * GET /sales/discount-code?branchId=N — ADMIN/ENCARGADO only.
 * Returns today's authorization code so the supervisor can share it verbally.
 */
/** Whoever asks for a code must be allowed to; the encargado gate is a setting. */
const assertCanReadDiscountCode = async (authUser: { role: string }) => {
  if (authUser.role === "ENCARGADO") {
    const settings = await readSettings();
    if (!settings.discountCodeVisibleToEncargado) {
      throw new SaleBranchAccessError(
        "El código de descuento lo entrega el administrador.",
      );
    }
  }
};

export const getDiscountCode = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.query.branchId);
    if (!authUser) {
      return res.status(401).json({ error: "No se pudo validar la identidad." });
    }
    if (!Number.isInteger(branchId) || branchId <= 0) {
      return res.status(400).json({ error: "Sucursal inválida." });
    }

    await assertCanReadDiscountCode(authUser);
    ensureBranchAccess(branchId, authUser);

    const settings = await readSettings();
    // In per-sale mode there is no standing code to show; the supervisor mints
    // one on demand via /generate. Report the mode so the UI knows which panel
    // to render instead of a code that would not exist.
    if (settings.discountCodeMode === "PER_SALE") {
      return res.status(200).json({ mode: "PER_SALE" });
    }
    res.status(200).json({ mode: "DAILY", code: dailyDiscountCode(branchId) });
  } catch (error) {
    if (error instanceof SaleBranchAccessError) {
      return res.status(403).json({ error: error.message });
    }
    res.status(403).json({ error: "Sin acceso a la sucursal indicada." });
  }
};

const PER_SALE_TTL_MINUTES = 30;

/**
 * POST /sales/discount-code/generate — ADMIN/ENCARGADO, per-sale mode only.
 * Mints a single-use code tied to this branch, valid for a short window. Sweeps
 * this branch's used/expired tokens first, so the table stays small.
 */
export const generateDiscountCode = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.body?.branchId);
    if (!authUser) {
      return res.status(401).json({ error: "No se pudo validar la identidad." });
    }
    if (!Number.isInteger(branchId) || branchId <= 0) {
      return res.status(400).json({ error: "Sucursal inválida." });
    }

    await assertCanReadDiscountCode(authUser);
    ensureBranchAccess(branchId, authUser);

    const settings = await readSettings();
    if (settings.discountCodeMode !== "PER_SALE") {
      return res.status(409).json({
        error: "El modo por venta no está activo. El código de hoy es el que corresponde.",
      });
    }

    const now = new Date();
    // Keep the table tiny: drop this branch's spent or expired codes each time.
    await prisma.discountToken.deleteMany({
      where: { branchId, OR: [{ used: true }, { expiresAt: { lt: now } }] },
    });

    // A random 6-digit code so it cannot be guessed from the day like the
    // daily one; retried on the rare collision with a live token.
    let code = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = String(
        parseInt(randomBytes(4).toString("hex"), 16) % 1_000_000,
      ).padStart(6, "0");
      const clash = await prisma.discountToken.findFirst({
        where: { branchId, code: candidate, used: false, expiresAt: { gt: now } },
      });
      if (!clash) {
        code = candidate;
        break;
      }
    }
    if (!code) {
      return res.status(500).json({ error: "No se pudo generar un código único, reintentá." });
    }

    const expiresAt = new Date(now.getTime() + PER_SALE_TTL_MINUTES * 60_000);
    await prisma.discountToken.create({
      data: { code, branchId, createdBy: authUser.id, expiresAt },
    });

    res.status(200).json({ code, expiresAt, ttlMinutes: PER_SALE_TTL_MINUTES });
  } catch (error) {
    if (error instanceof SaleBranchAccessError) {
      return res.status(403).json({ error: error.message });
    }
    logger.error("Error al generar el código de descuento:", error);
    res.status(500).json({ error: "No se pudo generar el código." });
  }
};

/**
 * POST /sales/discount-code/validate — any authenticated role.
 * Body: { branchId, code }. Confirms whether the typed code authorizes a
 * ticket discount. In per-sale mode the matching token is consumed here, so a
 * code works exactly once.
 */
export const validateDiscountCode = async (req: AuthRequest, res: Response) => {
  const branchId = Number(req.body?.branchId);
  const code = String(req.body?.code ?? "").trim();
  if (!Number.isInteger(branchId) || branchId <= 0 || !/^\d{6}$/u.test(code)) {
    return res.status(400).json({ valid: false });
  }

  try {
    const settings = await readSettings();

    if (settings.discountCodeMode === "PER_SALE") {
      const now = new Date();
      const token = await prisma.discountToken.findFirst({
        where: { branchId, code, used: false, expiresAt: { gt: now } },
      });
      if (!token) return res.status(200).json({ valid: false });
      // Burn it: one code, one discount. updateMany guards against a double
      // request racing to reuse the same token.
      const consumed = await prisma.discountToken.updateMany({
        where: { id: token.id, used: false },
        data: { used: true },
      });
      return res.status(200).json({ valid: consumed.count === 1 });
    }

    res.status(200).json({ valid: code === dailyDiscountCode(branchId) });
  } catch (error) {
    logger.error("Error al validar el código de descuento:", error);
    res.status(500).json({ valid: false });
  }
};

const normalizePaymentMethod = (value: unknown) => {
  const method = String(value || "").trim().toUpperCase();
  if (!method) throw new Error("El medio de pago es obligatorio.");
  return method;
};

const parseImmediatePayments = ({
  isCredit,
  paymentMethod,
  payments,
  totalAmount,
}: {
  isCredit: boolean;
  paymentMethod: unknown;
  payments: unknown;
  totalAmount: number;
}) => {
  if (!Array.isArray(payments) || payments.length === 0) {
    // Credit sale with no down payment: the whole total becomes debt.
    if (isCredit) return [];
    return [
      {
        paymentMethod: normalizePaymentMethod(paymentMethod),
        amount: roundMoney(totalAmount),
      },
    ];
  }

  const parsedPayments = payments.map((payment) => {
    if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
      throw new Error("Los pagos de la venta tienen un formato invalido.");
    }

    const typedPayment = payment as Record<string, unknown>;
    const method = normalizePaymentMethod(typedPayment.paymentMethod);
    const amount = Number(typedPayment.amount);

    if (method === "CREDIT_ACCOUNT") {
      throw new Error(
        "La cuenta corriente no puede mezclarse como medio de pago inmediato.",
      );
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Cada pago debe tener un importe positivo.");
    }

    return {
      paymentMethod: method,
      amount: roundMoney(amount),
    };
  });

  const paidAmount = roundMoney(
    parsedPayments.reduce((sum, payment) => sum + payment.amount, 0),
  );

  if (isCredit) {
    // Down payment on a credit sale: something must remain as debt —
    // otherwise it is a plain sale and must be charged as such.
    if (paidAmount >= roundMoney(totalAmount)) {
      throw new Error(
        "La entrega inicial cubre el total: cobrala como venta común, no como cuenta corriente.",
      );
    }
    return parsedPayments;
  }

  if (Math.abs(paidAmount - roundMoney(totalAmount)) > 0.01) {
    throw new Error(
      "La suma de los pagos no coincide con el total de la venta.",
    );
  }

  return parsedPayments;
};

const resolveSalePaymentMethod = (
  fallbackPaymentMethod: unknown,
  immediatePayments: { paymentMethod: string; amount: number }[],
) => {
  if (immediatePayments.length === 0) return "CREDIT_ACCOUNT";

  const uniqueMethods = new Set(
    immediatePayments.map((payment) => payment.paymentMethod),
  );

  if (uniqueMethods.size > 1) return "MIXED";
  return immediatePayments[0]?.paymentMethod || normalizePaymentMethod(fallbackPaymentMethod);
};

const calculateAvailableCash = (shift: {
  initialBalance: number;
  payments: { amount: number; paymentMethod: string }[];
  expenses: { amount: number }[];
}) => {
  const totalCashPayments = shift.payments.reduce((acc, payment) => {
    return payment.paymentMethod.toUpperCase() === "CASH"
      ? acc + payment.amount
      : acc;
  }, 0);

  const totalExpenses = shift.expenses.reduce(
    (acc, expense) => acc + expense.amount,
    0,
  );

  return shift.initialBalance + totalCashPayments - totalExpenses;
};

const ensureBranchAccess = (
  branchId: number,
  authUser: { role: string; branchIds: number[] },
) => {
  if (authUser.role === "ADMIN") return;

  if (!authUser.branchIds.includes(branchId)) {
    throw new SaleBranchAccessError("No tienes acceso a la sucursal indicada.");
  }
};

/**
 * PATCH /sales/:id/cancel
 *
 * Cancels a sale and restores product stock for the originating branch.
 * Only PAID or PENDING sales can be cancelled. PARTIAL sales are rejected.
 * A cancellation reason is required and stored in the sale record.
 * An internal receipt is created to audit the reversal.
 *
 * Access: ADMIN (any branch), ENCARGADO/EMPLOYEE (own branches only).
 *
 * @param id - Sale ID to cancel.
 * @body reason - Mandatory cancellation reason string.
 */
export const cancelSale = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const saleId = parsePositiveInt(req.params.id, "Venta");
    const reason = parseCancellationReason(req.body?.reason);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del operador.",
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const sale = await tx.sale.findUnique({
        where: { id: saleId },
        include: {
          items: true,
          payments: true,
        },
      });

      if (!sale) {
        throw new SaleNotFoundError("Venta o ticket no encontrado.");
      }

      ensureBranchAccess(sale.branchId, authUser);

      if (sale.status === "CANCELLED") {
        throw new Error("Esta venta ya fue anulada previamente.");
      }

      const originalPayments = sale.payments.filter(
        (payment) => payment.amount > 0,
      );
      const refundAmount = originalPayments.reduce(
        (sum, payment) => sum + payment.amount,
        0,
      );
      const cashRefundAmount = originalPayments.reduce((sum, payment) => {
        return payment.paymentMethod.toUpperCase() === "CASH"
          ? sum + payment.amount
          : sum;
      }, 0);
      let refundCashRegisterId: number | null = null;

      if (originalPayments.length > 0) {
        const activeRefundRegister = await tx.cashRegister.findFirst({
          where: {
            branchId: sale.branchId,
            status: "OPEN",
          },
          include: {
            payments: true,
            expenses: true,
          },
        });

        if (!activeRefundRegister) {
          throw new Error(
            "Debe haber una caja abierta en la sucursal para procesar la devolucion.",
          );
        }

        const availableCash = calculateAvailableCash(activeRefundRegister);
        if (cashRefundAmount > availableCash) {
          throw new Error(
            "No hay efectivo suficiente en la caja abierta para procesar la devolucion.",
          );
        }

        refundCashRegisterId = activeRefundRegister.id;
      }

      for (const item of sale.items) {
        await tx.stock.update({
          where: {
            productId_branchId: {
              productId: item.productId,
              branchId: sale.branchId,
            },
          },
          data: {
            quantity: {
              increment: item.quantity,
            },
          },
        });

        await tx.movement.create({
          data: {
            type: "IN",
            quantity: item.quantity,
            reason: `Anulacion de venta #${sale.id}: ${reason}`,
            productId: item.productId,
            branchId: sale.branchId,
            userId: authUser.id,
          },
        });
      }

      const cancelledSale = await tx.sale.update({
        where: { id: sale.id },
        data: {
          status: "CANCELLED",
          balance: 0,
        },
      });

      const refundPayments: { id: number }[] = [];
      if (originalPayments.length > 0) {
        if (!refundCashRegisterId) {
          throw new Error(
            "No se pudo asociar la devolucion a una caja abierta.",
          );
        }

        for (const payment of originalPayments) {
          const refundPayment = await tx.payment.create({
            data: {
              amount: -payment.amount,
              paymentMethod: payment.paymentMethod,
              saleId: sale.id,
              userId: authUser.id,
              branchId: sale.branchId,
              cashRegisterId: refundCashRegisterId,
            },
          });

          refundPayments.push(refundPayment);
        }
      }

      const isRefund = refundPayments.length > 0;
      const receiptType = isRefund ? "SALE_REFUND" : "SALE_CANCEL";

      await tx.auditLog.create({
        data: {
          actorUserId: authUser.id,
          branchId: sale.branchId,
          action: isRefund ? "SALE_REFUNDED" : "SALE_CANCELLED",
          entityType: "Sale",
          entityId: String(sale.id),
          metadata: {
            reason,
            previousStatus: sale.status,
            previousBalance: sale.balance,
            totalAmount: sale.totalAmount,
            restoredItems: sale.items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
            })),
            refundedAmount: refundAmount,
            refundPaymentIds: refundPayments.map((payment) => payment.id),
            refundCashRegisterId,
          },
        },
      });

      const receipt = await createInternalReceipt(tx, {
        receiptType,
        branchId: sale.branchId,
        cashRegisterId: refundCashRegisterId ?? sale.cashRegisterId,
        saleId: sale.id,
        sourceId: sale.id,
        createdBy: authUser.id,
        payload: {
          saleId: sale.id,
          reason,
          previousStatus: sale.status,
          previousBalance: sale.balance,
          totalAmount: sale.totalAmount,
          refundedAmount: refundAmount,
          refundPaymentIds: refundPayments.map((payment) => payment.id),
          refundCashRegisterId,
          originalPayments: originalPayments.map((payment) => ({
            id: payment.id,
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
            cashRegisterId: payment.cashRegisterId,
          })),
          restoredItemsCount: sale.items.length,
          restoredItems: sale.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            subtotal: item.subtotal,
          })),
        },
      });

      return { sale: cancelledSale, receipt };
    });

    res.status(200).json({
      message:
        result.receipt.receiptType === "SALE_REFUND"
          ? "Venta devuelta correctamente. Stock, caja y reportes fueron revertidos."
          : "Venta anulada correctamente. Stock y deuda fueron revertidos.",
      data: result.sale,
      receipt: result.receipt,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Error crítico al anular la venta.";

    res.status(responseStatusForSaleError(error)).json({ error: errorMsg });
  }
};

/**
 * POST /sales
 *
 * Creates a new sale. Supports single and split-payment methods:
 * CASH, DEBIT, CREDIT, TRANSFER, CUENTA_CORRIENTE (accounts-receivable).
 *
 * Transaction guarantees:
 * - Stock deduction per product/branch
 * - Payment records persisted
 * - Sale status set to PAID (fully paid), PENDING (full fiado), or PARTIAL (split)
 * - Internal receipt created
 * - Sale linked to the active cash register shift
 *
 * @body branchId       - Branch where the sale is made.
 * @body cashRegisterId - ID of the open shift (required).
 * @body customerId     - Required for `CUENTA_CORRIENTE` sales.
 * @body paymentMethod  - Top-level payment method (used when `payments` is absent).
 * @body payments       - Array of `{ method, amount }` for split payments.
 * @body totalAmount    - Total sale amount in ARS.
 * @body items          - Array of `{ productId, quantity, unitPrice, unitCost }`.
 * @body pickedUpBy     - Optional: name of the person picking up the order.
 */
export const createSale = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const {
      branchId,
      cashRegisterId,
      customerId,
      paymentMethod,
      payments,
      totalAmount,
      cashReceived,
      items,
      pickedUpBy,
      note,
      cardBrand,
      cardLast4,
      cardInstallments,
      cardSurchargePct,
      couponNumber,
    } = req.body;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del vendedor.",
      });
    }

    // Clave de idempotencia: cabecera estándar `Idempotency-Key`. Se valida el
    // formato para no guardar basura como clave primaria.
    const rawIdempotencyKey =
      typeof req.headers["idempotency-key"] === "string"
        ? req.headers["idempotency-key"].trim()
        : "";

    if (rawIdempotencyKey && !IDEMPOTENCY_KEY_PATTERN.test(rawIdempotencyKey)) {
      return res.status(400).json({
        error:
          "La cabecera Idempotency-Key tiene un formato inválido " +
          "(8 a 120 caracteres alfanuméricos, guiones o guiones bajos).",
      });
    }

    const idempotencyKey = rawIdempotencyKey || null;

    const parsedBranchId = Number(branchId);
    ensureBranchAccess(parsedBranchId, authUser);

    // ── Quién está operando esta caja ──
    //
    // Se resuelve FUERA de la transacción porque puede crear la sesión legado
    // de quien todavía no configuró su PIN, y eso no debe quedar atado al
    // commit de la venta: si la venta falla por stock, la sesión de operador
    // sigue siendo válida y el cajero no tiene que identificarse de nuevo.
    //
    // No bloquea: si la computadora no está enrolada como terminal, la venta
    // procede igual y se marca como atribución inferida. Frenar una venta en el
    // mostrador por una fila de configuración faltante es inaceptable.
    const resolved = await resolvePosContext(req);
    const posContext = resolved instanceof PosContextError ? null : resolved;
    const parsedTotalAmount = Number(totalAmount) > 0 ? Number(totalAmount) : 0.01;
    const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
    const isCredit = normalizedPaymentMethod === "CREDIT_ACCOUNT";

    // Card reconciliation metadata is only meaningful when a card was involved.
    // The terminal handles the PAN; we keep brand/cuotas/coupon/last4 to match
    // the Posnet receipt. Surcharge % is informational and never alters totals.
    const involvesCard =
      normalizedPaymentMethod === "DEBIT" ||
      normalizedPaymentMethod === "CREDIT" ||
      normalizedPaymentMethod === "MIXED";
    const cardData = involvesCard
      ? {
          cardBrand: cardBrand ? String(cardBrand).toUpperCase().slice(0, 40) : null,
          cardLast4: /^\d{4}$/u.test(String(cardLast4 ?? "")) ? String(cardLast4) : null,
          cardInstallments:
            Number.isFinite(Number(cardInstallments)) && Number(cardInstallments) > 0
              ? Math.trunc(Number(cardInstallments))
              : null,
          cardSurchargePct:
            Number.isFinite(Number(cardSurchargePct)) && Number(cardSurchargePct) >= 0
              ? Number(cardSurchargePct)
              : null,
          couponNumber: couponNumber ? String(couponNumber).slice(0, 40) : null,
        }
      : { cardBrand: null, cardLast4: null, cardInstallments: null, cardSurchargePct: null, couponNumber: null };

    // Validaciones de crédito que NO dependen del total. El chequeo de límite,
    // que sí depende, pasó adentro de la transacción (ver `executeSale`).
    if (isCredit) {
      if (!customerId) {
        throw new Error(
          "Operacion rechazada: Las ventas en cuenta corriente exigen un cliente titular registrado.",
        );
      }
      if (!pickedUpBy || pickedUpBy.trim().length < 3) {
        throw new Error(
          "Operacion rechazada: Debe especificar el nombre y DNI de la persona autorizada al retiro.",
        );
      }
    }

    // Sólo ADMIN y ENCARGADO pueden fijar un precio excepcional.
    const canOverridePrice = authUser.role === "ADMIN" || authUser.role === "ENCARGADO";

    // Todo el trabajo de la venta, listo para correr dentro de una transacción
    // —propia o la que abre el envoltorio de idempotencia—.
    const executeSale = async (tx: PrismaTx) => {
      const activeRegister = await tx.cashRegister.findUnique({
        where: { id: Number(cashRegisterId) },
      });

      if (!activeRegister || activeRegister.status !== "OPEN") {
        throw new Error(
          "Operación bloqueada: No hay un turno de caja abierto para registrar esta operación.",
        );
      }

      if (activeRegister.branchId !== parsedBranchId) {
        throw new Error(
          "La caja abierta no pertenece a la misma sucursal de la venta.",
        );
      }

      // ── 1. El precio lo pone la BASE, no el navegador ──
      // Se resuelve DENTRO de la transacción: el precio que se valida es el
      // mismo que se congela, sin ventana para que cambie en el medio.
      const { lines, total: authoritativeTotal } = await priceSaleLines(
        tx,
        items.map((item: Record<string, unknown>) => ({
          productId: Number(item.productId),
          quantity: Number(item.quantity),
          discountPct:
            item.discountPct === undefined || item.discountPct === null
              ? null
              : Number(item.discountPct),
          priceOverride:
            item.priceOverride === undefined || item.priceOverride === null
              ? null
              : Number(item.priceOverride),
        })),
        { role: authUser.role, canOverridePrice },
      );

      // ── 2. ¿Coincide con lo que el operador vio en pantalla? ──
      // Si no, se rechaza. Nunca se cobra en silencio un monto distinto al
      // confirmado: el request se aborta entero, sin venta, sin stock, sin cobro.
      assertTotalMatches(parsedTotalAmount, authoritativeTotal, lines);

      const totalNumber = authoritativeTotal.toNumber();

      // ── 3. Los pagos se validan contra el total AUTORITATIVO ──
      // Antes se validaban contra el total del cliente, así que la comprobación
      // se mordía la cola: pagos falsos cuadraban con un total falso.
      const immediatePayments = parseImmediatePayments({
        isCredit,
        paymentMethod: normalizedPaymentMethod,
        payments,
        totalAmount: totalNumber,
      });

      const paidNow = roundMoney(
        immediatePayments.reduce((sum, payment) => sum + payment.amount, 0),
      );
      const debtAmount = isCredit ? roundMoney(totalNumber - paidNow) : 0;
      const salePaymentMethod = isCredit
        ? "CREDIT_ACCOUNT"
        : resolveSalePaymentMethod(normalizedPaymentMethod, immediatePayments);

      // ── 4. Efectivo recibido y vuelto, contra el COMPONENTE en efectivo ──
      const cashComponent = immediatePayments
        .filter((payment) => payment.paymentMethod === "CASH")
        .reduce((sum, payment) => sum.plus(toDecimal(payment.amount)), toDecimal(0));
      const { cashReceived: cashIn, changeGiven } = resolveCashChange(
        cashReceived,
        cashComponent,
      );

      // ── 5. Límite de crédito, DENTRO de la transacción y con lock ──
      // Estaba afuera: dos fiados simultáneos leían el mismo saldo y ambos
      // pasaban, superando juntos un límite que ninguno superaba solo.
      // `FOR UPDATE` serializa a los competidores sobre la fila del cliente.
      if (isCredit && customerId) {
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${Number(customerId)} FOR UPDATE`;

        const customer = await tx.customer.findUnique({
          where: { id: Number(customerId) },
          select: { creditLimit: true, name: true },
        });

        if (customer && customer.creditLimit > 0) {
          const currentDebt = await tx.sale.aggregate({
            where: { customerId: Number(customerId), status: { in: ["PENDING", "PARTIAL"] } },
            _sum: { balance: true },
          });
          const outstanding = Number(currentDebt._sum.balance ?? 0);
          if (outstanding + debtAmount > customer.creditLimit) {
            const available = Math.max(0, customer.creditLimit - outstanding);
            throw new Error(
              `Límite de crédito superado para ${customer.name}. Disponible: $${available.toLocaleString("es-AR")}. ` +
              `Deuda actual: $${outstanding.toLocaleString("es-AR")}. Límite: $${customer.creditLimit.toLocaleString("es-AR")}.`,
            );
          }
        }
      }

      // ── 6. En qué computadora se hizo la venta ──
      //
      // DUAL-WRITE: la venta nace con su terminal cuando se puede resolver.
      //
      // Si la sucursal todavía no tiene ninguna, la venta se registra igual con
      // `terminalId` en null — la columna es nullable justamente para eso, y en
      // un mostrador no se puede dejar de vender porque falte una fila de
      // configuración.
      //
      // Lo que SÍ se rechaza es la incoherencia: una terminal declarada que no
      // existe, está desactivada, es de otra sucursal, o contradice la
      // credencial de dispositivo. La cookie manda sobre el cuerpo.
      const terminal = await resolveTerminalIfAvailable(
        tx,
        parsedBranchId,
        req.body?.terminalId ? Number(req.body.terminalId) : null,
        req.terminal,
      );

      // ── ATRIBUCIÓN: quién vendió y quién cobró ──
      //
      // Sale del contexto del servidor, nunca del cuerpo. Si el cuerpo declara
      // una identidad distinta se rechaza con 409 en vez de sobrescribirla en
      // silencio: un cliente desincronizado tiene que enterarse, porque de esto
      // dependen la comisión y el arqueo.
      const attribution = await resolveSaleAttribution(tx, {
        posContext: posContext ?? null,
        authUser,
        declared: {
          userId: req.body?.userId ?? null,
          sellerId: req.body?.sellerId ?? null,
          cashierId: req.body?.cashierId ?? null,
          // `branchId` y `cashRegisterId` NO se contrastan acá: el propio
          // controlador ya los tomó del cuerpo como entrada legítima y los
          // validó contra la caja abierta y el acceso del usuario. Volver a
          // compararlos contra sí mismos no probaría nada.
        },
        resolvedBranchId: parsedBranchId,
        resolvedCashRegisterId: Number(cashRegisterId),
      });

      const saleKind = await resolveSaleKind(
        tx,
        customerId ? Number(customerId) : null,
      );

      // A credit sale with a down payment starts PARTIAL: part is in the till,
      // the rest is receivable on the customer's account.
      const initialStatus = isCredit ? (paidNow > 0 ? "PARTIAL" : "PENDING") : "PAID";
      const initialBalance = debtAmount;

      const newSale = await tx.sale.create({
        data: {
          totalAmount: authoritativeTotal,
          paymentMethod: salePaymentMethod,
          cashReceived: cashIn,
          changeGiven,
          status: initialStatus,
          balance: initialBalance,
          pickedUpBy: isCredit ? pickedUpBy : null,
          note: typeof note === "string" && note.trim() ? note.trim().slice(0, 300) : null,
          ...cardData,
          customerId: customerId ? Number(customerId) : null,
          branchId: parsedBranchId,
          // `userId` se conserva por compatibilidad hacia atrás: lo leen
          // reportes y consultas que todavía no migraron. Las filas nuevas lo
          // llenan con el VENDEDOR, que es lo que ese campo siempre quiso decir.
          userId: attribution.sellerId,
          sellerId: attribution.sellerId,
          cashierId: attribution.cashierId,
          operatorSessionId: attribution.operatorSessionId,
          sellerNameSnapshot: attribution.sellerNameSnapshot,
          cashierNameSnapshot: attribution.cashierNameSnapshot,
          attributionLegacy: attribution.attributionLegacy,
          kind: saleKind,
          terminalId: terminal?.id ?? null,
          cashRegisterId: Number(cashRegisterId),
          // Última barrera: aunque el IdempotencyRecord se perdiera, el índice
          // único de esta columna sigue rechazando la venta duplicada.
          idempotencyKey,
        },
      });

      // Se recorren las líneas YA RESUELTAS por el servidor, no las del
      // payload: precios, costos y subtotales salen de la base.
      for (const line of lines) {
        // El descuento valida y escribe en una sola sentencia atómica: la
        // condición viaja en el WHERE, no en un `if` de JavaScript. Sin esto,
        // dos cajas vendiendo la última unidad leían `1`, ambas pasaban la
        // validación y ambas escribían `0`. Ver src/utils/stock.utils.ts.
        await decrementStockOrThrow(
          tx,
          { productId: line.productId, branchId: parsedBranchId },
          line.quantity,
        );

        await tx.saleItem.create({
          data: {
            saleId: newSale.id,
            productId: line.productId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            subtotal: line.subtotal,
            // `null` = costo DESCONOCIDO. Antes se escribía `0`, que significa
            // "no costó nada" y le inventa a la venta un margen del 100%.
            unitCost: line.unitCost,
            listPrice: line.listPrice,
            discountPct: line.discountPct,
          },
        });

        await tx.movement.create({
          data: {
            type: "OUT",
            quantity: line.quantity,
            reason: `Venta #${newSale.id} ${isCredit ? "(Cuenta Corriente)" : ""}`,
            productId: line.productId,
            branchId: parsedBranchId,
            // El movimiento de stock lo genera quien vendió.
            userId: attribution.sellerId,
          },
        });

        // Un precio excepcional se audita SIEMPRE: quién, sobre qué, cuánto se
        // apartó de la lista y en qué venta. Sin esto, un override es
        // indistinguible de un precio normal al revisar el histórico.
        if (line.overridden) {
          await tx.auditLog.create({
            data: {
              actorUserId: authUser.id,
              branchId: parsedBranchId,
              action: "SALE_PRICE_OVERRIDE",
              entityType: "SaleItem",
              entityId: String(newSale.id),
              metadata: {
                saleId: newSale.id,
                productId: line.productId,
                sku: line.sku,
                productName: line.productName,
                listPrice: line.listPrice.toFixed(4),
                chargedPrice: line.unitPrice.toFixed(4),
                quantity: line.quantity,
              },
            },
          });
        }
      }

      const createdPayments: { id: number; amount: number; paymentMethod: string }[] = [];
      for (const payment of immediatePayments) {
        const createdPayment = await tx.payment.create({
          data: {
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
            saleId: newSale.id,
            // El CAJERO, no el dueño del token: de este campo sale de quién es
            // el faltante cuando el arqueo no cierra.
            userId: attribution.cashierId,
            branchId: parsedBranchId,
            cashRegisterId: Number(cashRegisterId),
          },
        });
        createdPayments.push(createdPayment);
      }

      const receipt = await createInternalReceipt(tx, {
        receiptType: "SALE",
        branchId: parsedBranchId,
        cashRegisterId: Number(cashRegisterId),
        saleId: newSale.id,
        paymentId: createdPayments.length === 1 ? createdPayments[0]?.id : null,
        sourceId: newSale.id,
        createdBy: authUser.id,
        payload: {
          saleId: newSale.id,
          totalAmount: totalNumber,
          paymentMethod: salePaymentMethod,
          payments: createdPayments.map((payment) => ({
            id: payment.id,
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
          })),
          paymentsCount: createdPayments.length,
          status: initialStatus,
          balance: initialBalance,
          customerId: customerId ? Number(customerId) : null,
          pickedUpBy: isCredit ? pickedUpBy : null,
          cashReceived: cashIn ? cashIn.toNumber() : null,
          changeGiven: changeGiven ? changeGiven.toNumber() : null,
          // El desglose que resolvió el SERVIDOR, no el que mandó el cliente.
          items: lines.map((line) => ({
            productId: line.productId,
            sku: line.sku,
            name: line.productName,
            quantity: line.quantity,
            listPrice: line.listPrice.toNumber(),
            unitPrice: line.unitPrice.toNumber(),
            subtotal: line.subtotal.toNumber(),
            discountPct: line.discountPct ? line.discountPct.toNumber() : null,
          })),
        },
      });

      return { sale: newSale, receipt, salePaymentMethod, paidNow };
    };

    // El mensaje depende de cómo se resolvió el cobro, que ahora se decide
    // dentro de la transacción (con el total autoritativo).
    const successMessage = (method: string, paid: number) =>
      method === "CREDIT_ACCOUNT"
        ? paid > 0
          ? "Venta a credito registrada con entrega inicial."
          : "Venta a credito registrada."
        : method === "MIXED"
          ? "Venta procesada con pagos multiples."
          : "Venta procesada con éxito.";

    // ── Sin clave de idempotencia ──────────────────────────────────────────
    // Se acepta durante una release para no romper clientes viejos, pero queda
    // registrado: esta venta viaja SIN protección contra duplicados.
    if (!idempotencyKey) {
      logger.warn(
        `[IDEMPOTENCIA] Venta sin Idempotency-Key (usuario ${authUser.id}, sucursal ${parsedBranchId}). ` +
          "Un reintento de red podría duplicarla.",
      );
      const result = await prisma.$transaction(executeSale);
      return res.status(201).json({
        message: successMessage(result.salePaymentMethod, result.paidNow),
        data: result.sale,
        receipt: result.receipt,
      });
    }

    const outcome = await withIdempotency(
      {
        key: idempotencyKey,
        payload: req.body,
        scope: userBranchScope(authUser.id, parsedBranchId),
      },
      async (tx) => {
        const result = await executeSale(tx);
        return {
          value: result,
          resultType: "sale",
          resultId: String(result.sale.id),
          httpStatus: 201,
        };
      },
    );

    if (outcome.kind === "conflict") {
      return res.status(409).json({ error: outcome.message, code: outcome.code });
    }

    if (outcome.kind === "replayed") {
      // Ya se había registrado: se devuelve LA MISMA venta, no una nueva.
      const saleId = Number(outcome.resultId);
      const [sale, receipt] = await Promise.all([
        prisma.sale.findUnique({ where: { id: saleId } }),
        prisma.internalReceipt.findFirst({
          where: { saleId, receiptType: "SALE" },
        }),
      ]);
      return res.status(200).json({
        message: "Esta venta ya estaba registrada. Se devuelve el comprobante original.",
        data: sale,
        receipt,
        replayed: true,
      });
    }

    return res.status(201).json({
      message: successMessage(outcome.value.salePaymentMethod, outcome.value.paidNow),
      data: outcome.value.sale,
      receipt: outcome.value.receipt,
    });
  } catch (error: unknown) {
    // ── El total cambió entre que el operador lo vio y confirmó ──
    //
    // Se responde 409 con el desglose autoritativo para que el POS refresque el
    // ticket y el operador REVISE Y CONFIRME el monto nuevo. Nunca se cobra en
    // silencio un importe distinto al que estaba en pantalla.
    //
    // El request rechazado no dejó nada: la transacción se revirtió entera, así
    // que no hay venta, ni stock descontado, ni pagos, ni comprobante.
    // Terminal inexistente, desactivada, de otra sucursal, o distinta de la que
    // esta computadora tiene enrolada. Es un problema con salida clara, no un
    // fallo del servidor.
    if (error instanceof TerminalResolutionError) {
      return res.status(400).json({ error: error.message, code: "TERMINAL_MISMATCH" });
    }

    // El cuerpo declaró una identidad que contradice la que resolvió el
    // servidor. Se rechaza en vez de sobrescribir en silencio: de la atribución
    // dependen la comisión y el arqueo, así que un cliente desincronizado tiene
    // que enterarse ahora y no a fin de mes.
    if (error instanceof IdentityMismatchError) {
      return res.status(409).json({ error: error.message, code: error.code });
    }

    if (error instanceof TotalMismatchError) {
      return res.status(409).json({
        error: error.message,
        code: "TOTAL_MISMATCH",
        expectedTotal: error.expected.toNumber(),
        authoritativeTotal: error.authoritative.toNumber(),
        breakdown: error.breakdown.map((line) => ({
          productId: line.productId,
          sku: line.sku,
          name: line.productName,
          quantity: line.quantity,
          listPrice: line.listPrice.toNumber(),
          unitPrice: line.unitPrice.toNumber(),
          subtotal: line.subtotal.toNumber(),
          discountPct: line.discountPct ? line.discountPct.toNumber() : null,
        })),
      });
    }

    // Última barrera de idempotencia: la venta ya existía con esta misma clave,
    // aunque su `IdempotencyRecord` ya no esté (purgado, borrado a mano, base
    // restaurada). El índice único de `Sale.idempotencyKey` la frenó.
    //
    // Devolver la venta original es la respuesta CORRECTA, no un error: el
    // cliente pidió "registrá esto una vez" y está registrado. Sin esto, el
    // cajero veía un mensaje crudo de Prisma sobre restricciones únicas.
    if (isUniqueConstraintViolation(error)) {
      const key =
        typeof req.headers["idempotency-key"] === "string"
          ? req.headers["idempotency-key"].trim()
          : "";

      if (key) {
        const existing = await prisma.sale.findUnique({
          where: { idempotencyKey: key },
        });
        if (existing) {
          const receipt = await prisma.internalReceipt.findFirst({
            where: { saleId: existing.id, receiptType: "SALE" },
          });
          return res.status(200).json({
            message:
              "Esta venta ya estaba registrada. Se devuelve el comprobante original.",
            data: existing,
            receipt,
            replayed: true,
          });
        }
      }
    }

    const errorMsg =
      error instanceof Error
        ? error.message
        : "Error crítico al procesar la venta.";
    res.status(400).json({ error: errorMsg });
  }
};

/**
 * GET /sales/pending/:branchId
 *
 * Returns all open receivables (sales with status PENDING or PARTIAL) for the
 * given branch. Pass `branchId=0` for a cross-branch view (ADMIN gets all;
 * non-ADMIN gets only their own branches).
 * Includes customer info, payment history, and aging data.
 *
 * @param branchId - Branch ID or 0 for consolidated view.
 */
export const getPendingAccounts = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.params.branchId);
    const pendingStatuses = ["PENDING", "PARTIAL"];

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const whereClause =
      branchId === 0
        ? authUser.role === "ADMIN"
          ? { status: { in: pendingStatuses } }
          : {
              branchId: { in: authUser.branchIds },
              status: { in: pendingStatuses },
            }
        : {
            branchId,
            status: { in: pendingStatuses },
          };

    const pendingSales = await prisma.sale.findMany({
      where: whereClause,
      include: {
        customer: { select: { id: true, name: true, type: true, phone: true } },
        user: { select: { name: true } },
        payments: {
          select: {
            id: true,
            amount: true,
            paymentMethod: true,
            createdAt: true,
            user: { select: { name: true } },
          },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    res.status(200).json({ message: "Radar actualizado.", data: pendingSales });
  } catch (error: unknown) {
    res.status(500).json({ error: "Fallo al consultar el radar de deudores." });
  }
};

/**
 * GET /sales/pending/export-excel
 *
 * Streams an Excel file with all open receivables (PENDING + PARTIAL) filtered
 * by branch. Used by the accounts-receivable module for offline reporting.
 *
 * @query branchId - Branch filter (0 = all branches, ADMIN only).
 */
export const exportPendingAccountsExcel = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.query.branchId ?? 0);
    const pendingStatuses = ["PENDING", "PARTIAL"];

    if (!authUser) {
      return res.status(401).json({ error: "No autorizado." });
    }

    const whereClause =
      branchId === 0
        ? authUser.role === "ADMIN"
          ? { status: { in: pendingStatuses } }
          : {
              branchId: { in: authUser.branchIds },
              status: { in: pendingStatuses },
            }
        : { branchId, status: { in: pendingStatuses } };

    const pendingSales = await prisma.sale.findMany({
      where: whereClause,
      include: {
        customer: { select: { name: true, type: true, phone: true } },
        user: { select: { name: true } },
        branch: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "El Club de la Pintura ERP";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Cuentas Corrientes");

    sheet.columns = [
      { header: "Fecha", key: "date", width: 14 },
      { header: "Nº Venta", key: "id", width: 10 },
      { header: "Cliente", key: "customer", width: 28 },
      { header: "Retira", key: "pickedUpBy", width: 22 },
      { header: "Sucursal", key: "branch", width: 18 },
      { header: "Total ($)", key: "total", width: 14 },
      { header: "Saldo ($)", key: "balance", width: 14 },
      { header: "Estado", key: "status", width: 12 },
      { header: "Días deuda", key: "ageDays", width: 12 },
      { header: "Vendedor", key: "seller", width: 22 },
    ];

    // Styled header row
    const headerRow = sheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E293B" },
    };
    headerRow.alignment = { vertical: "middle", horizontal: "center" };
    headerRow.height = 22;

    const today = new Date();

    const STATUS_LABELS: Record<string, string> = {
      PENDING: "Pendiente",
      PARTIAL: "Pago parcial",
    };

    pendingSales.forEach((sale) => {
      const ageDays = Math.floor(
        (today.getTime() - new Date(sale.createdAt).getTime()) /
          (1000 * 60 * 60 * 24),
      );
      // sale.balance = outstanding amount (updated by the backend on each partial payment)
      const balance = Number(sale.balance);

      const row = sheet.addRow({
        date: new Date(sale.createdAt).toLocaleDateString("es-AR", {
          timeZone: "America/Argentina/Buenos_Aires",
        }),
        id: sale.id,
        customer: sale.customer?.name ?? "Consumidor Final",
        pickedUpBy: sale.pickedUpBy ?? "-",
        branch: sale.branch?.name ?? "-",
        total: Number(sale.totalAmount),
        balance,
        status: STATUS_LABELS[sale.status] ?? sale.status,
        ageDays,
        seller: sale.user?.name ?? "-",
      });

      // Color-code rows by aging bucket
      const fgColor =
        ageDays > 60
          ? "FFFEE2E2" // light red
          : ageDays > 30
            ? "FFFEF9C3" // light yellow
            : "FFF0FDF4"; // light green

      row.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: fgColor },
      };

      // Currency format
      const moneyFmt = '"$"#,##0.00';
      row.getCell("total").numFmt = moneyFmt;
      row.getCell("balance").numFmt = moneyFmt;
    });

    // Summary totals at the bottom of the sheet
    const lastRow = sheet.rowCount + 2;
    sheet.getCell(`F${lastRow}`).value = pendingSales.reduce(
      (acc, s) => acc + Number(s.totalAmount),
      0,
    );
    sheet.getCell(`G${lastRow}`).value = pendingSales.reduce(
      (acc, s) => acc + Number(s.balance),
      0,
    );
    sheet.getCell(`F${lastRow}`).numFmt = '"$"#,##0.00';
    sheet.getCell(`G${lastRow}`).numFmt = '"$"#,##0.00';
    sheet.getCell(`F${lastRow}`).font = { bold: true };
    sheet.getCell(`G${lastRow}`).font = { bold: true, color: { argb: "FFDC2626" } };
    sheet.getCell(`E${lastRow}`).value = "TOTAL";
    sheet.getCell(`E${lastRow}`).font = { bold: true };

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=CuentasCorrientes_${today.toISOString().slice(0, 10)}.xlsx`,
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error: unknown) {
    logger.error("Error exportando cuentas corrientes:", error);
    res.status(500).json({ error: "No se pudo generar el Excel." });
  }
};

/**
 * GET /sales
 *
 * Returns the 100 most recent sales visible to the authenticated user.
 * ADMIN sees all branches; ENCARGADO/EMPLOYEE see only their own branches.
 * Includes branch, customer, user, items, and payments.
 */
export const getSales = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const cashRegisterId = req.query.cashRegisterId
      ? Number(req.query.cashRegisterId)
      : undefined;
    const branchIdFilter = req.query.branchId
      ? Number(req.query.branchId)
      : undefined;
    const limitParam = req.query.limit ? Number(req.query.limit) : 100;
    const take = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 500) : 100;

    const branchWhere =
      authUser.role === "ADMIN"
        ? branchIdFilter
          ? { branchId: branchIdFilter }
          : undefined
        : { branchId: { in: authUser.branchIds, ...(branchIdFilter ? { equals: branchIdFilter } : {}) } };

    const sales = await prisma.sale.findMany({
      where: {
        ...branchWhere,
        ...(cashRegisterId ? { cashRegisterId } : {}),
      },
      take,
      orderBy: { createdAt: "desc" },
      include: {
        customer: { select: { name: true, document: true } },
        user: { select: { name: true } },
      },
    });

    res
      .status(200)
      .json({ message: "Historial de ventas recuperado.", data: sales });
  } catch (error: unknown) {
    res.status(500).json({ error: "Fallo al obtener el historial de ventas." });
  }
};

/**
 * GET /sales/:id
 *
 * Returns the full detail of a single sale by ID, including items (with product
 * info), customer, operator, branch, and all linked payments.
 * Non-ADMIN users can only access sales from their own branches.
 *
 * @param id - Sale ID.
 */
export const getSaleById = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const saleId = parsePositiveInt(req.params.id, "Venta");

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        customer: true,
        user: { select: { name: true } },
        items: {
          include: {
            product: { select: { name: true, sku: true, brand: true } },
          },
        },
        payments: {
          orderBy: { createdAt: "desc" },
          include: { user: { select: { name: true } } },
        },
      },
    });

    if (!sale) throw new Error("Venta o ticket no encontrado en el sistema.");

    ensureBranchAccess(sale.branchId, authUser);

    // ── El costo se OMITE del payload, no se esconde en la pantalla ──
    //
    // Ocultarlo con CSS o con un `if` en el componente no es control de acceso:
    // el dato viaja igual y está a un clic de las herramientas de desarrollo.
    // Un vendedor no tiene por qué poder ver el margen del negocio, así que la
    // clave directamente no sale del servidor.
    const puedeVerCostos = capabilitiesForRole(authUser.role).has("costs:view");

    const data = {
      ...sale,
      items: sale.items.map((item) =>
        puedeVerCostos ? item : { ...item, unitCost: undefined },
      ),
      // El snapshot manda sobre la relación: renombrar a alguien no reescribe
      // los comprobantes que ya emitió.
      seller: {
        id: sale.sellerId ?? sale.userId,
        name: sale.sellerNameSnapshot ?? sale.user?.name ?? "—",
      },
      cashier: {
        id: sale.cashierId ?? sale.userId,
        name: sale.cashierNameSnapshot ?? sale.user?.name ?? "—",
      },
      isConsumidorFinal: sale.customerId === null,
    };

    res
      .status(200)
      .json({ message: "Detalle de ticket recuperado.", data });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Error desconocido.";
    const statusCode = error instanceof SaleBranchAccessError ? 403 : 404;

    res.status(statusCode).json({ error: errorMsg });
  }
};

/**
 * GET /sales/:id/receipt-pdf
 *
 * Streams a PDF receipt for the sale identified by `:id`. The document includes
 * branch header, customer info, itemized list, totals, and payment breakdown.
 * Suitable for screen display or printing on a standard printer.
 * (For 80mm thermal receipt format, see the planned ticket-print feature.)
 *
 * @param id - Sale ID.
 */
export const generateSaleReceiptPdf = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const saleId = parsePositiveInt(req.params.id, "Venta");

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const sale = await prisma.sale.findUnique({
      where: { id: saleId },
      include: {
        branch: true,
        cashRegister: true,
        // Para imprimir en qué computadora se cobró. Nullable: las ventas
        // anteriores a la Fase 3 no la tienen y el ticket cae al formato viejo.
        terminal: { select: { code: true } },
        customer: true,
        user: { select: { name: true } },
        items: {
          include: {
            product: { select: { name: true, sku: true, brand: true } },
          },
        },
        payments: {
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!sale) {
      return res.status(404).json({ error: "Venta no encontrada." });
    }

    ensureBranchAccess(sale.branchId, authUser);

    const internalReceipt = await prisma.internalReceipt.findFirst({
      where: {
        saleId: sale.id,
        receiptType: "SALE",
      },
      orderBy: { createdAt: "desc" },
    });

    if (!internalReceipt) {
      return res.status(404).json({
        error: "No se encontro el comprobante interno de esta venta.",
      });
    }

    const paidAmount = sale.payments.reduce(
      (sum, payment) => sum + payment.amount,
      0,
    );
    const documentHeight = Math.max(620, 420 + sale.items.length * 42);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${internalReceipt.receiptNumber}.pdf"`,
    );

    const doc = new PDFDocument({
      size: [226.77, documentHeight],
      margin: 18,
    });

    doc.pipe(res);
    doc.fontSize(13).text("El Club de la Pintura", { align: "center" });
    doc.moveDown(0.3);
    doc
      .fontSize(8)
      .text("Ticket interno de venta - No fiscal", { align: "center" });
    doc.moveDown(0.8);
    doc.fontSize(8).text(`Comprobante: ${internalReceipt.receiptNumber}`);
    doc.text(`Fecha: ${formatReceiptDate(sale.createdAt)}`);
    doc.text(`Sucursal: ${sale.branch.name}`);
    // The customer keeps this slip: the address tells them which shop to walk
    // back into for a return. Data-driven, so editing it in Configuración
    // updates every future ticket.
    if (sale.branch.location?.trim()) {
      doc.text(sale.branch.location.trim());
    }
    // Terminal + turno juntos: ante un reclamo, dicen exactamente en qué
    // computadora y en qué turno se cobró. Sin la terminal, "Caja: 203" sólo
    // identifica el turno, no la máquina — y con dos puestos por sucursal eso
    // ya no alcanza para rastrear un faltante hasta su cajón.
    const etiquetaTerminal = sale.terminal?.code ?? null;
    doc.text(
      etiquetaTerminal
        ? `Terminal: ${etiquetaTerminal} · Turno: ${sale.cashRegisterId ?? "—"}`
        : `Caja: ${sale.cashRegisterId ?? "Sin caja vinculada"}`,
    );
    doc.text(`Vendedor: ${sale.user.name}`);
    doc.moveDown(0.8);
    doc.text(`Ticket: #${sale.id}`);
    doc.text(`Cliente: ${sale.customer?.name ?? "Consumidor Final"}`);
    if (sale.customer?.document) {
      doc.text(`Documento: ${sale.customer.document}`);
    }
    if (sale.pickedUpBy) {
      doc.text(`Retiro autorizado: ${sale.pickedUpBy}`);
    }
    if (sale.note) {
      doc.text(`Nota: ${sale.note}`);
    }
    doc.moveDown(0.8);
    doc.text("Detalle de productos");
    doc.moveDown(0.3);

    sale.items.forEach((item) => {
      doc.fontSize(8).text(`${item.product.name} (${item.product.sku})`);
      const discountPct = Number(item.discountPct ?? 0);
      const listPrice = item.listPrice != null ? Number(item.listPrice) : null;
      // When a discount was recorded, show the original price struck through-style
      // and the discount, then the final line — supermarket-style transparency.
      if (discountPct > 0 && listPrice && listPrice > Number(item.unitPrice)) {
        doc.fillColor("#888888").text(
          `   Precio lista: ${formatMoney(listPrice)} · Desc ${discountPct}%`,
          { align: "right" },
        );
        doc.fillColor("black");
      }
      doc.text(
        `${item.quantity} x ${formatMoney(item.unitPrice)} = ${formatMoney(
          item.subtotal,
        )}`,
        { align: "right" },
      );
      doc.moveDown(0.3);
    });

    doc.moveDown(0.6);
    doc.fontSize(9).text(`Medio principal: ${sale.paymentMethod}`);
    // Card reconciliation line (brand · cuotas · cupón · últimos 4)
    if (sale.cardBrand || sale.couponNumber || sale.cardLast4 || sale.cardInstallments) {
      const cardBits: string[] = [];
      if (sale.cardBrand) cardBits.push(sale.cardBrand);
      if (sale.cardInstallments && sale.cardInstallments > 1) cardBits.push(`${sale.cardInstallments} cuotas`);
      if (sale.cardLast4) cardBits.push(`•••• ${sale.cardLast4}`);
      if (cardBits.length > 0) doc.fontSize(8).text(`Tarjeta: ${cardBits.join(" · ")}`);
      if (sale.couponNumber) doc.fontSize(8).text(`Cupón: ${sale.couponNumber}`);
      if (sale.cardSurchargePct && Number(sale.cardSurchargePct) > 0) {
        doc.fontSize(8).text(`Recargo informado: ${Number(sale.cardSurchargePct)}%`);
      }
      doc.fontSize(9);
    }
    doc.text(`Estado: ${sale.status}`);
    doc.text(`Total: ${formatMoney(sale.totalAmount)}`);
    doc.text(`Cobrado: ${formatMoney(paidAmount)}`);
    doc.text(`Saldo pendiente: ${formatMoney(sale.balance)}`);
    doc.moveDown(1);
    doc.fontSize(8).text("Este comprobante es interno y auditable.", {
      align: "center",
    });
    doc.text("No reemplaza factura fiscal.", { align: "center" });
    doc.end();
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Fallo al procesar el ticket en el servidor.";
    const statusCode = error instanceof SaleBranchAccessError ? 403 : 400;

    res.status(statusCode).json({ error: errorMsg });
  }
};

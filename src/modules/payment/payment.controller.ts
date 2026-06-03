/**
 * Payment Controller — accounts-receivable payment registration and receipts.
 *
 * Handles partial and full payments against open sales (PENDING / PARTIAL status).
 * Each payment:
 * - Deducts from the sale's outstanding balance
 * - Updates sale status (PARTIAL → PAID when fully collected)
 * - Creates a `Payment` record linked to the current cash register shift
 * - Creates an internal receipt for audit purposes
 *
 * Allowed payment methods for account payments: CASH, DEBIT, CREDIT, TRANSFER, MIXED.
 * CUENTA_CORRIENTE is intentionally excluded (can't pay a fiado with another fiado).
 *
 * @module payment.controller
 */
import { Response } from "express";
import PDFDocument from "pdfkit";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";

class PaymentBranchAccessError extends Error {}

const allowedAccountPaymentMethods = new Set([
  "CASH",
  "DEBIT",
  "CREDIT",
  "TRANSFER",
  "MIXED",
]);

const parsePositiveInt = (value: unknown, fieldName: string) => {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} invalido.`);
  }

  return parsed;
};

const parsePositiveAmount = (value: unknown) => {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("El monto de integracion debe ser mayor a cero.");
  }

  return parsed;
};

const parseAccountPaymentMethod = (value: unknown) => {
  if (typeof value !== "string") {
    throw new Error("El medio de pago es obligatorio.");
  }

  const normalizedMethod = value.trim().toUpperCase();

  if (!allowedAccountPaymentMethods.has(normalizedMethod)) {
    throw new Error(
      "El medio de pago seleccionado no es válido para cobrar una cuenta corriente.",
    );
  }

  return normalizedMethod;
};

const formatMoney = (amount: number) =>
  `$ ${amount.toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatReceiptDate = (date: Date) =>
  date.toLocaleString("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  });

/**
 * POST /payments/account
 *
 * Registers a payment against an open receivable (sale with PENDING or PARTIAL status).
 * Validates that the cash register shift is open and that the payment amount does not
 * exceed the remaining balance. Updates the sale status atomically.
 *
 * @body saleId         - The open sale to pay against.
 * @body cashRegisterId - The active shift receiving the payment.
 * @body amount         - Payment amount (must be > 0 and ≤ remaining balance).
 * @body paymentMethod  - One of: CASH, DEBIT, CREDIT, TRANSFER, MIXED.
 */
export const registerAccountPayment = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const { saleId, amount, paymentMethod, cashRegisterId } = req.body;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del cobrador.",
      });
    }

    const parsedSaleId = parsePositiveInt(saleId, "Ticket de origen");
    const parsedCashRegisterId = parsePositiveInt(
      cashRegisterId,
      "Turno de caja",
    );
    const paymentAmount = parsePositiveAmount(amount);
    const normalizedPaymentMethod = parseAccountPaymentMethod(paymentMethod);

    const result = await prisma.$transaction(async (tx) => {
      const activeRegister = await tx.cashRegister.findUnique({
        where: { id: parsedCashRegisterId },
      });

      if (!activeRegister || activeRegister.status !== "OPEN") {
        throw new Error(
          "Operacion bloqueada: No se puede cobrar sin un turno de caja abierto.",
        );
      }

      if (
        authUser.role !== "ADMIN" &&
        !authUser.branchIds.includes(activeRegister.branchId)
      ) {
        throw new PaymentBranchAccessError(
          "No tienes acceso a la sucursal de esta caja.",
        );
      }

      const targetSale = await tx.sale.findUnique({
        where: { id: parsedSaleId },
      });

      if (!targetSale) throw new Error("Ticket de origen no encontrado.");
      if (
        authUser.role !== "ADMIN" &&
        !authUser.branchIds.includes(targetSale.branchId)
      ) {
        throw new PaymentBranchAccessError(
          "No tienes acceso a la sucursal de esta cuenta.",
        );
      }
      if (targetSale.status === "PAID" || targetSale.balance <= 0) {
        throw new Error("Esta cuenta ya se encuentra saldada.");
      }
      if (targetSale.branchId !== activeRegister.branchId) {
        throw new Error(
          "La caja abierta no pertenece a la misma sucursal de la cuenta.",
        );
      }
      if (paymentAmount > targetSale.balance) {
        throw new Error(
          `El monto ($${paymentAmount}) supera el saldo pendiente ($${targetSale.balance}).`,
        );
      }

      const newBalance = targetSale.balance - paymentAmount;
      const newStatus = newBalance === 0 ? "PAID" : "PARTIAL";

      await tx.sale.update({
        where: { id: targetSale.id },
        data: { balance: newBalance, status: newStatus },
      });

      const newPayment = await tx.payment.create({
        data: {
          amount: paymentAmount,
          paymentMethod: normalizedPaymentMethod,
          saleId: targetSale.id,
          userId: authUser.id,
          branchId: targetSale.branchId,
          cashRegisterId: activeRegister.id,
        },
      });

      const receipt = await createInternalReceipt(tx, {
        receiptType: "PAYMENT",
        branchId: targetSale.branchId,
        cashRegisterId: activeRegister.id,
        saleId: targetSale.id,
        paymentId: newPayment.id,
        sourceId: newPayment.id,
        createdBy: authUser.id,
        payload: {
          paymentId: newPayment.id,
          saleId: targetSale.id,
          amount: paymentAmount,
          paymentMethod: normalizedPaymentMethod,
          previousBalance: targetSale.balance,
          newBalance,
          status: newStatus,
        },
      });

      return { payment: newPayment, receipt, newBalance, status: newStatus };
    });

    res.status(201).json({
      message:
        result.status === "PAID"
          ? "Cuenta saldada en su totalidad."
          : `Pago parcial. Saldo restante: $ ${result.newBalance.toLocaleString("es-AR")} ARS`,
      data: result,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Error crítico al registrar el pago.";
    const statusCode = error instanceof PaymentBranchAccessError ? 403 : 400;

    res.status(statusCode).json({ error: errorMsg });
  }
};

/**
 * POST /payments/debt-collection
 *
 * Alias for `registerAccountPayment`. Provided as a semantic alternative
 * route for debt collection flows. Delegates to the same implementation.
 */
export const registerDebtCollection = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    return await registerAccountPayment(req, res);
  } catch (error: unknown) {
    res.status(500).json({ error: "Error en el cobro de deuda original." });
  }
};

/**
 * GET /payments/:paymentId/receipt-pdf
 *
 * Streams a PDF receipt for a single payment. Includes: branch, customer,
 * payment method, amount, sale reference, and operator. Used by the
 * accounts-receivable module to provide the debtor with a payment confirmation.
 *
 * @param paymentId - Payment record ID.
 */
export const generatePrintableReceipt = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const paymentId = parsePositiveInt(req.params.paymentId, "Pago");

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        branch: true,
        cashRegister: true,
        sale: {
          include: {
            customer: true,
          },
        },
        user: true,
      },
    });

    if (!payment) {
      return res.status(404).json({ error: "Pago no encontrado." });
    }

    if (
      authUser.role !== "ADMIN" &&
      !authUser.branchIds.includes(payment.branchId)
    ) {
      return res.status(403).json({
        error: "No tienes acceso al comprobante de esta sucursal.",
      });
    }

    const internalReceipt = await prisma.internalReceipt.findFirst({
      where: {
        paymentId: payment.id,
        receiptType: "PAYMENT",
      },
      orderBy: { createdAt: "desc" },
    });

    if (!internalReceipt) {
      return res.status(404).json({
        error: "No se encontro el comprobante interno de este pago.",
      });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${internalReceipt.receiptNumber}.pdf"`,
    );

    const doc = new PDFDocument({
      size: [226.77, 560],
      margin: 18,
    });

    doc.pipe(res);
    doc.fontSize(13).text("El Club de la Pintura", { align: "center" });
    doc.moveDown(0.3);
    doc
      .fontSize(8)
      .text("Comprobante interno de pago - No fiscal", { align: "center" });
    doc.moveDown(0.8);
    doc.fontSize(8).text(`Recibo: ${internalReceipt.receiptNumber}`);
    doc.text(`Fecha: ${formatReceiptDate(payment.createdAt)}`);
    doc.text(`Sucursal: ${payment.branch.name}`);
    doc.text(`Caja: ${payment.cashRegisterId ?? "Sin caja vinculada"}`);
    doc.text(`Cajero: ${payment.user.name}`);
    doc.moveDown(0.8);
    doc.text(`Ticket origen: #${payment.saleId}`);
    doc.text(`Cliente: ${payment.sale.customer?.name ?? "Consumidor Final"}`);
    doc.text(`Retiro autorizado: ${payment.sale.pickedUpBy ?? "No informado"}`);
    doc.moveDown(0.8);
    doc.text(`Medio de pago: ${payment.paymentMethod}`);
    doc.fontSize(12).text(`Importe cobrado: ${formatMoney(payment.amount)}`);
    doc.fontSize(8).text(`Saldo posterior: ${formatMoney(payment.sale.balance)}`);
    doc.text(`Estado de cuenta: ${payment.sale.status}`);
    doc.moveDown(1);
    doc.text("Este comprobante es interno y auditable.", { align: "center" });
    doc.text("No reemplaza factura fiscal.", { align: "center" });
    doc.end();
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Fallo al procesar el recibo en el servidor.";

    res
      .status(400)
      .json({ error: errorMsg });
  }
};

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
import { Response } from "express";
import { Payment } from "@prisma/client";
import { logger } from '../../config/logger';
import PDFDocument from "pdfkit";
import * as ExcelJS from "exceljs";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";

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
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  });

const parseCancellationReason = (value: unknown) => {
  if (typeof value !== "string" || value.trim().length < 5) {
    throw new Error("Debe indicar un motivo de anulacion claro.");
  }

  return value.trim().slice(0, 500);
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

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
  if (isCredit) return [];

  if (!Array.isArray(payments) || payments.length === 0) {
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

      const refundPayments: Payment[] = [];
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
        : "Error critico al anular la venta.";

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
      items,
      pickedUpBy,
    } = req.body;

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del vendedor.",
      });
    }

    const parsedBranchId = Number(branchId);
    ensureBranchAccess(parsedBranchId, authUser);
    const parsedTotalAmount = Number(totalAmount) > 0 ? Number(totalAmount) : 0.01;
    const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod);
    const isCredit = normalizedPaymentMethod === "CREDIT_ACCOUNT";

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

    const immediatePayments = parseImmediatePayments({
      isCredit,
      paymentMethod: normalizedPaymentMethod,
      payments,
      totalAmount: parsedTotalAmount,
    });
    const salePaymentMethod = resolveSalePaymentMethod(
      normalizedPaymentMethod,
      immediatePayments,
    );

    const result = await prisma.$transaction(async (tx) => {
      const activeRegister = await tx.cashRegister.findUnique({
        where: { id: Number(cashRegisterId) },
      });

      if (!activeRegister || activeRegister.status !== "OPEN") {
        throw new Error(
          "Operacion bloqueada: No hay un turno de caja abierto para registrar esta operacion.",
        );
      }

      if (activeRegister.branchId !== parsedBranchId) {
        throw new Error(
          "La caja abierta no pertenece a la misma sucursal de la venta.",
        );
      }

      const initialStatus = isCredit ? "PENDING" : "PAID";
      const initialBalance = isCredit ? parsedTotalAmount : 0;

      const newSale = await tx.sale.create({
        data: {
          totalAmount: parsedTotalAmount,
          paymentMethod: salePaymentMethod,
          status: initialStatus,
          balance: initialBalance,
          pickedUpBy: isCredit ? pickedUpBy : null,
          customerId: customerId ? Number(customerId) : null,
          branchId: parsedBranchId,
          userId: authUser.id,
          cashRegisterId: Number(cashRegisterId),
        },
      });

      for (const item of items) {
        const [currentStock, productRecord] = await Promise.all([
          tx.stock.findUnique({
            where: {
              productId_branchId: {
                productId: Number(item.productId),
                branchId: parsedBranchId,
              },
            },
          }),
          tx.product.findUnique({
            where: { id: Number(item.productId) },
            select: { name: true, sku: true },
          }),
        ]);

        const productLabel = productRecord
          ? `${productRecord.name} (${productRecord.sku})`
          : `producto ID ${item.productId}`;

        if (!currentStock) {
          throw new Error(
            `Stock no encontrado para ${productLabel} en esta sucursal.`,
          );
        }

        if (currentStock.quantity < Number(item.quantity)) {
          throw new Error(
            `Stock insuficiente para "${productLabel}": hay ${currentStock.quantity} ud. disponibles pero se pidieron ${item.quantity}.`,
          );
        }

        await tx.stock.update({
          where: { id: currentStock.id },
          data: { quantity: currentStock.quantity - Number(item.quantity) },
        });

        await tx.saleItem.create({
          data: {
            saleId: newSale.id,
            productId: Number(item.productId),
            quantity: Number(item.quantity),
            unitPrice: Number(item.unitPrice),
            subtotal: Number(item.quantity) * Number(item.unitPrice),
            unitCost: item.unitCost ? Number(item.unitCost) : 0,
          },
        });

        await tx.movement.create({
          data: {
            type: "OUT",
            quantity: Number(item.quantity),
            reason: `Venta #${newSale.id} ${isCredit ? "(Cuenta Corriente)" : ""}`,
            productId: Number(item.productId),
            branchId: parsedBranchId,
            userId: authUser.id,
          },
        });
      }

      const createdPayments: Payment[] = [];
      for (const payment of immediatePayments) {
        const createdPayment = await tx.payment.create({
          data: {
            amount: payment.amount,
            paymentMethod: payment.paymentMethod,
            saleId: newSale.id,
            userId: authUser.id,
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
          totalAmount: parsedTotalAmount,
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
          items,
        },
      });

      return { sale: newSale, receipt };
    });

    res.status(201).json({
      message:
        salePaymentMethod === "CREDIT_ACCOUNT"
          ? "Venta a credito registrada."
          : salePaymentMethod === "MIXED"
            ? "Venta procesada con pagos multiples."
          : "Venta procesada con exito.",
      data: result.sale,
      receipt: result.receipt,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Error critico al procesar la venta.";
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
        date: new Date(sale.createdAt).toLocaleDateString("es-AR"),
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

    res
      .status(200)
      .json({ message: "Detalle de ticket recuperado.", data: sale });
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
    doc.text(`Caja: ${sale.cashRegisterId ?? "Sin caja vinculada"}`);
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
    doc.moveDown(0.8);
    doc.text("Detalle de productos");
    doc.moveDown(0.3);

    sale.items.forEach((item) => {
      doc.fontSize(8).text(`${item.product.name} (${item.product.sku})`);
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

import { Response } from "express";
import PDFDocument from "pdfkit";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

const buildReceiptBranchWhere = (
  rawBranchId: unknown,
  authUser: { role: string; branchIds: number[] },
) => {
  const branchId = rawBranchId === undefined ? 0 : Number(rawBranchId);

  if (branchId === 0) {
    return authUser.role === "ADMIN" ? undefined : { in: authUser.branchIds };
  }

  if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
    throw new Error("No tienes acceso a la sucursal del comprobante.");
  }

  return branchId;
};

const receiptTypeTitle: Record<string, string> = {
  SALE: "Ticket interno de venta",
  SALE_CANCEL: "Anulacion interna de venta",
  SALE_REFUND: "Devolucion interna de venta",
  PAYMENT: "Comprobante interno de pago",
  EXPENSE: "Comprobante interno de egreso",
  CASH_CLOSE: "Arqueo interno de caja",
};

type ReceiptPdfRow = [string, string];

const toPayloadRecord = (payload: unknown) => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {} as Record<string, unknown>;
  }

  return payload as Record<string, unknown>;
};

const getPayloadText = (
  payload: Record<string, unknown>,
  key: string,
  fallback = "-",
) => {
  const value = payload[key];

  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
};

const getPayloadNumber = (payload: Record<string, unknown>, key: string) => {
  const value = payload[key];
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
};

const formatMoney = (amount: number) =>
  `$ ${amount.toLocaleString("es-AR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const formatDate = (value: Date | string | null | undefined) => {
  if (!value) return "-";

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);

  return parsed.toLocaleString("es-AR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Argentina/Buenos_Aires",
  });
};

const buildReceiptRows = (
  receiptType: string,
  payload: Record<string, unknown>,
): ReceiptPdfRow[] => {
  if (receiptType === "SALE") {
    return [
      ["Ticket", `#${getPayloadText(payload, "saleId")}`],
      ["Medio principal", getPayloadText(payload, "paymentMethod")],
      ["Estado", getPayloadText(payload, "status")],
      ["Total", formatMoney(getPayloadNumber(payload, "totalAmount"))],
      ["Saldo pendiente", formatMoney(getPayloadNumber(payload, "balance"))],
      ["Retiro autorizado", getPayloadText(payload, "pickedUpBy")],
    ];
  }

  if (receiptType === "PAYMENT") {
    return [
      ["Pago", `#${getPayloadText(payload, "paymentId")}`],
      ["Ticket origen", `#${getPayloadText(payload, "saleId")}`],
      ["Medio de pago", getPayloadText(payload, "paymentMethod")],
      ["Importe cobrado", formatMoney(getPayloadNumber(payload, "amount"))],
      [
        "Saldo anterior",
        formatMoney(getPayloadNumber(payload, "previousBalance")),
      ],
      ["Saldo posterior", formatMoney(getPayloadNumber(payload, "newBalance"))],
      ["Estado de cuenta", getPayloadText(payload, "status")],
    ];
  }

  if (receiptType === "SALE_CANCEL") {
    return [
      ["Venta anulada", `#${getPayloadText(payload, "saleId")}`],
      ["Motivo", getPayloadText(payload, "reason")],
      ["Estado anterior", getPayloadText(payload, "previousStatus")],
      [
        "Saldo anterior",
        formatMoney(getPayloadNumber(payload, "previousBalance")),
      ],
      ["Total original", formatMoney(getPayloadNumber(payload, "totalAmount"))],
      ["Items restaurados", getPayloadText(payload, "restoredItemsCount", "0")],
    ];
  }

  if (receiptType === "SALE_REFUND") {
    return [
      ["Venta devuelta", `#${getPayloadText(payload, "saleId")}`],
      ["Motivo", getPayloadText(payload, "reason")],
      ["Estado anterior", getPayloadText(payload, "previousStatus")],
      ["Total original", formatMoney(getPayloadNumber(payload, "totalAmount"))],
      ["Importe devuelto", formatMoney(getPayloadNumber(payload, "refundedAmount"))],
      ["Caja de devolucion", `#${getPayloadText(payload, "refundCashRegisterId")}`],
      ["Items restaurados", getPayloadText(payload, "restoredItemsCount", "0")],
    ];
  }

  if (receiptType === "EXPENSE") {
    return [
      ["Egreso", `#${getPayloadText(payload, "expenseId")}`],
      ["Monto retirado", formatMoney(getPayloadNumber(payload, "amount"))],
      ["Motivo", getPayloadText(payload, "reason")],
      ["Categoria", getPayloadText(payload, "category")],
      ["Tipo", getPayloadText(payload, "type")],
      [
        "Caja esperada anterior",
        formatMoney(getPayloadNumber(payload, "previousExpectedBalance")),
      ],
      [
        "Caja esperada nueva",
        formatMoney(getPayloadNumber(payload, "newExpectedBalance")),
      ],
    ];
  }

  if (receiptType === "CASH_CLOSE") {
    return [
      ["Caja", `#${getPayloadText(payload, "cashRegisterId")}`],
      ["Apertura", formatDate(getPayloadText(payload, "openedAt"))],
      ["Cierre", formatDate(getPayloadText(payload, "closedAt"))],
      ["Fondo inicial", formatMoney(getPayloadNumber(payload, "initialBalance"))],
      ["Esperado", formatMoney(getPayloadNumber(payload, "expectedBalance"))],
      ["Contado", formatMoney(getPayloadNumber(payload, "actualBalance"))],
      ["Diferencia", formatMoney(getPayloadNumber(payload, "discrepancy"))],
      ["Observaciones", getPayloadText(payload, "observations")],
      ["Cobranzas", getPayloadText(payload, "paymentsCount", "0")],
      ["Egresos", getPayloadText(payload, "expensesCount", "0")],
    ];
  }

  return Object.entries(payload).map(([key, value]) => {
    const printableValue =
      typeof value === "object" ? JSON.stringify(value) : String(value);

    return [key, printableValue] as ReceiptPdfRow;
  });
};

export const getInternalReceipts = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const branchWhere = buildReceiptBranchWhere(req.query.branchId, authUser);
    const receiptType =
      typeof req.query.receiptType === "string"
        ? req.query.receiptType
        : undefined;
    const take = Math.min(Number(req.query.limit || 100), 300);

    const receipts = await prisma.internalReceipt.findMany({
      where: {
        ...(branchWhere === undefined ? {} : { branchId: branchWhere }),
        ...(receiptType ? { receiptType } : {}),
      },
      orderBy: { createdAt: "desc" },
      take,
    });

    res.status(200).json({
      message: "Comprobantes internos recuperados.",
      data: receipts,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo recuperar comprobantes internos.";
    res.status(400).json({ error: errorMsg });
  }
};

export const generateInternalReceiptPdf = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const receiptId = String(req.params.id || "");

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    if (!receiptId) {
      return res.status(400).json({ error: "Falta el ID del comprobante." });
    }

    const receipt = await prisma.internalReceipt.findUnique({
      where: { id: receiptId },
    });

    if (!receipt) {
      return res.status(404).json({ error: "Comprobante no encontrado." });
    }

    if (
      authUser.role !== "ADMIN" &&
      !authUser.branchIds.includes(receipt.branchId)
    ) {
      return res.status(403).json({
        error: "No tienes acceso a la sucursal del comprobante.",
      });
    }

    const [branch, operator] = await Promise.all([
      prisma.branch.findUnique({ where: { id: receipt.branchId } }),
      prisma.user.findUnique({
        where: { id: receipt.createdBy },
        select: { name: true },
      }),
    ]);

    const payload = toPayloadRecord(receipt.payload);
    const detailRows = buildReceiptRows(receipt.receiptType, payload);
    const documentHeight = Math.max(560, 320 + detailRows.length * 34);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${receipt.receiptNumber}.pdf"`,
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
      .text(receiptTypeTitle[receipt.receiptType] || "Comprobante interno", {
        align: "center",
      });
    doc.text("Documento interno - No fiscal", { align: "center" });
    doc.moveDown(0.8);
    doc.text(`Comprobante: ${receipt.receiptNumber}`);
    doc.text(`Fecha: ${formatDate(receipt.createdAt)}`);
    doc.text(`Sucursal: ${branch?.name ?? `#${receipt.branchId}`}`);
    doc.text(`Caja: ${receipt.cashRegisterId ?? "Sin caja vinculada"}`);
    doc.text(`Operador: ${operator?.name ?? `#${receipt.createdBy}`}`);
    doc.moveDown(0.8);

    detailRows.forEach(([label, value]) => {
      doc.fontSize(7).fillColor("#64748b").text(label.toUpperCase());
      doc.fontSize(9).fillColor("#0f172a").text(value);
      doc.moveDown(0.35);
    });

    doc.moveDown(0.6);
    doc.fillColor("#0f172a");
    doc.fontSize(8).text("Este comprobante es interno y auditable.", {
      align: "center",
    });
    doc.text("No reemplaza factura fiscal.", { align: "center" });
    doc.end();
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo generar el PDF del comprobante.";

    res.status(400).json({ error: errorMsg });
  }
};

export const getInternalReceiptById = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const authUser = getAuthUser(req);
    const receiptId = String(req.params.id || "");

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    if (!receiptId) {
      return res.status(400).json({ error: "Falta el ID del comprobante." });
    }

    const receipt = await prisma.internalReceipt.findUnique({
      where: { id: receiptId },
    });

    if (!receipt) {
      return res.status(404).json({ error: "Comprobante no encontrado." });
    }

    if (
      authUser.role !== "ADMIN" &&
      !authUser.branchIds.includes(receipt.branchId)
    ) {
      return res.status(403).json({
        error: "No tienes acceso a la sucursal del comprobante.",
      });
    }

    res.status(200).json({
      message: "Comprobante interno recuperado.",
      data: receipt,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo recuperar el comprobante interno.";
    res.status(400).json({ error: errorMsg });
  }
};

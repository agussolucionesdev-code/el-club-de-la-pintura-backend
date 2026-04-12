import { Response } from "express";
import PDFDocument from "pdfkit";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";

class SaleBranchAccessError extends Error {}

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

const ensureBranchAccess = (
  branchId: number,
  authUser: { role: string; branchIds: number[] },
) => {
  if (authUser.role === "ADMIN") return;

  if (!authUser.branchIds.includes(branchId)) {
    throw new SaleBranchAccessError("No tienes acceso a la sucursal indicada.");
  }
};

export const createSale = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const {
      branchId,
      cashRegisterId,
      customerId,
      paymentMethod,
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

    if (paymentMethod === "CREDIT_ACCOUNT") {
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

      const isCredit = paymentMethod === "CREDIT_ACCOUNT";
      const initialStatus = isCredit ? "PENDING" : "PAID";
      const initialBalance = isCredit ? Number(totalAmount) : 0;

      const newSale = await tx.sale.create({
        data: {
          totalAmount: Number(totalAmount),
          paymentMethod,
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
        const currentStock = await tx.stock.findUnique({
          where: {
            productId_branchId: {
              productId: Number(item.productId),
              branchId: parsedBranchId,
            },
          },
        });

        if (!currentStock || currentStock.quantity < Number(item.quantity)) {
          throw new Error(
            `Inconsistencia de inventario: stock insuficiente para el producto ID ${item.productId}.`,
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

      const immediatePayment = !isCredit
        ? await tx.payment.create({
            data: {
              amount: Number(totalAmount),
              paymentMethod,
              saleId: newSale.id,
              userId: authUser.id,
              branchId: parsedBranchId,
              cashRegisterId: Number(cashRegisterId),
            },
          })
        : null;

      const receipt = await createInternalReceipt(tx, {
        receiptType: "SALE",
        branchId: parsedBranchId,
        cashRegisterId: Number(cashRegisterId),
        saleId: newSale.id,
        paymentId: immediatePayment?.id,
        sourceId: newSale.id,
        createdBy: authUser.id,
        payload: {
          saleId: newSale.id,
          totalAmount: Number(totalAmount),
          paymentMethod,
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
        paymentMethod === "CREDIT_ACCOUNT"
          ? "Venta a credito registrada."
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
      },
      orderBy: { createdAt: "asc" },
    });

    res.status(200).json({ message: "Radar actualizado.", data: pendingSales });
  } catch (error: unknown) {
    res.status(500).json({ error: "Fallo al consultar el radar de deudores." });
  }
};

export const getSales = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const sales = await prisma.sale.findMany({
      where:
        authUser.role === "ADMIN"
          ? undefined
          : { branchId: { in: authUser.branchIds } },
      take: 100,
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

import { Request, Response } from "express";
import prisma from "../../config/db";
import PDFDocument from "pdfkit"; // LIBRERÍA DE PDF

// ============================================================================
// REGISTRAR COBRANZA: Abono a Cuenta Corriente y Auditoría de Caja
// ============================================================================
export const registerDebtCollection = async (req: Request, res: Response) => {
  try {
    const { saleId, amount, paymentMethod, branchId } = req.body;
    const authUser = (req as any).user;

    if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
      return res.status(403).json({
        error: "No tienes autorización para ingresar dinero en esta sucursal.",
      });
    }

    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({ error: "El monto a cobrar debe ser mayor a cero." });
    }

    const transactionResult = await prisma.$transaction(async (tx) => {
      // 1. INYECCIÓN DE CAJA
      const activeShift = await tx.cashRegister.findFirst({
        where: { userId: authUser.id, branchId: branchId, status: "OPEN" },
      });

      if (!activeShift) {
        throw new Error(
          "Operación denegada: Debes abrir tu turno de caja antes de cobrar deudas.",
        );
      }

      // 2. BUSCAR FACTURA
      const sale = await tx.sale.findUnique({
        where: { id: Number(saleId) },
        include: { customer: true },
      });

      if (!sale)
        throw new Error("La factura indicada no existe en el sistema.");
      if (sale.balance <= 0 || sale.status === "PAID")
        throw new Error("Esta factura ya se encuentra totalmente saldada.");
      if (amount > sale.balance)
        throw new Error(
          `El monto ingresado ($${amount}) supera la deuda actual ($${sale.balance}).`,
        );

      // 3. ACTUALIZAR SALDOS
      const newBalance = sale.balance - amount;
      const newStatus = newBalance === 0 ? "PAID" : "PARTIAL";

      // 4. GENERAR RECIBO INTERNO
      const paymentReceipt = await tx.payment.create({
        data: {
          amount,
          paymentMethod,
          saleId: sale.id,
          userId: authUser.id,
          branchId,
          cashRegisterId: activeShift.id,
        },
      });

      // 5. PURGA Y ACTUALIZACIÓN DE FACTURA
      const updatedSale = await tx.sale.update({
        where: { id: sale.id },
        data: { balance: newBalance, status: newStatus },
      });

      return { paymentReceipt, updatedSale, customer: sale.customer };
    });

    res.status(201).json({
      message: "Cobranza registrada exitosamente.",
      receiptId: transactionResult.paymentReceipt.id, // ID vital para luego generar el PDF
      data: transactionResult,
    });
  } catch (error: any) {
    console.error("Error al procesar la cobranza:", error);
    if (error instanceof Error)
      return res.status(400).json({ error: error.message });
    res.status(500).json({ error: "Fallo estructural al procesar el pago." });
  }
};

// ============================================================================
// GENERAR COMPROBANTE PDF: Renderizado de recibo oficial para impresión
// ============================================================================
export const generatePrintableReceipt = async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;

    // Buscar todos los datos relacionales necesarios para el recibo
    const payment = await prisma.payment.findUnique({
      where: { id: Number(paymentId) },
      include: {
        sale: { include: { customer: true } },
        user: { select: { name: true } },
        branch: { select: { name: true } },
      },
    });

    if (!payment)
      return res.status(404).json({ error: "Recibo no encontrado." });

    // Configurar cabeceras de respuesta para descargar/mostrar PDF
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="recibo_pago_${payment.id}.pdf"`,
    );

    // Iniciar Motor PDF
    const doc = new PDFDocument({ margin: 50, size: "A5" }); // Tamaño A5 ideal para comprobantes
    doc.pipe(res);

    // DIBUJO DEL RECIBO (Diseño Profesional)
    doc
      .fontSize(20)
      .font("Helvetica-Bold")
      .text("EL CLUB PINTURERÍAS", { align: "center" });
    doc.moveDown(0.5);
    doc
      .fontSize(12)
      .font("Helvetica")
      .text("COMPROBANTE OFICIAL DE PAGO", { align: "center" });
    doc
      .moveTo(50, doc.y + 10)
      .lineTo(350, doc.y + 10)
      .stroke(); // Línea separadora
    doc.moveDown(1.5);

    // Datos Operativos
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(`Recibo N°: `, { continued: true })
      .font("Helvetica")
      .text(`${payment.id.toString().padStart(6, "0")}`);
    doc
      .font("Helvetica-Bold")
      .text(`Fecha y Hora: `, { continued: true })
      .font("Helvetica")
      .text(`${payment.createdAt.toLocaleString("es-AR")}`);
    doc
      .font("Helvetica-Bold")
      .text(`Sucursal: `, { continued: true })
      .font("Helvetica")
      .text(`${payment.branch.name}`);
    doc
      .font("Helvetica-Bold")
      .text(`Cajero: `, { continued: true })
      .font("Helvetica")
      .text(`${payment.user.name}`);
    doc.moveDown(1);

    // Datos del Cliente
    doc.fontSize(12).font("Helvetica-Bold").text("DATOS DEL CLIENTE");
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(`Nombre: `, { continued: true })
      .font("Helvetica")
      .text(`${payment.sale.customer?.name || "Consumidor Final"}`);
    doc
      .font("Helvetica-Bold")
      .text(`DNI/CUIT: `, { continued: true })
      .font("Helvetica")
      .text(`${payment.sale.customer?.document || "N/A"}`);
    doc.moveDown(1);

    // Datos Financieros
    doc.fontSize(12).font("Helvetica-Bold").text("DETALLE DE COBRANZA");
    doc
      .fontSize(10)
      .font("Helvetica-Bold")
      .text(`Ref. Factura N°: `, { continued: true })
      .font("Helvetica")
      .text(`${payment.sale.id}`);
    doc
      .font("Helvetica-Bold")
      .text(`Método de Pago: `, { continued: true })
      .font("Helvetica")
      .text(`${payment.paymentMethod}`);

    // Total cobrado en grande
    doc.moveDown(1);
    doc
      .fontSize(18)
      .font("Helvetica-Bold")
      .text(`MONTO ABONADO: $${payment.amount.toFixed(2)}`, { align: "right" });

    doc.moveDown(2);
    doc
      .fontSize(8)
      .font("Helvetica-Oblique")
      .text(
        "Este documento es un comprobante de abono a cuenta corriente. Gracias por confiar en nosotros.",
        { align: "center" },
      );

    // Finalizar documento (Esto dispara el envío al cliente)
    doc.end();
  } catch (error) {
    console.error("Error generando PDF:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al renderizar el documento PDF." });
  }
};

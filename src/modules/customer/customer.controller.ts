/**
 * Customer Controller — client (cuenta corriente) management.
 *
 * Handles full CRUD for customers. Customer types: CONSUMIDOR, CONTRATISTA,
 * EMPRESA, FAMILIAR. Customers are soft-deleted (`isActive = false`) to preserve
 * historical sale references. Every create/update/delete writes an audit log entry.
 *
 * @module customer.controller
 */
import { Prisma } from "@prisma/client";
import { Response } from "express";
import PDFDocument from "pdfkit";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

const toJsonPayload = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const auditCustomerAction = async (
  actorUserId: number | undefined,
  action: string,
  entityId: string,
  metadata: Record<string, unknown>,
) => {
  if (!actorUserId) return;

  await prisma.auditLog.create({
    data: {
      actorUserId,
      action,
      entityType: "Customer",
      entityId,
      metadata: toJsonPayload(metadata),
    },
  });
};

// ============================================================================
// READ: Fetch the active customer directory
// ============================================================================
/**
 * GET /customers
 *
 * Returns all active customers with their total outstanding balance.
 * Supports optional text search by name or document number.
 *
 * @query search - Optional filter applied to name and document fields.
 */
export const getCustomers = async (req: AuthRequest, res: Response) => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : "";
    const limit = req.query.limit ? Math.min(200, Math.max(1, Number(req.query.limit))) : undefined;

    const searchFilter = search
      ? {
          OR: [
            { name: { contains: search, mode: "insensitive" as const } },
            { document: { contains: search, mode: "insensitive" as const } },
            { email: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {};

    // Optional ?type= filter (e.g. INTERNAL for staff consumption accounts)
    // and ?excludeType= (the POS customer picker hides INTERNAL accounts so
    // staff and clients never mix in the same list).
    const typeFilter = req.query.type ? { type: String(req.query.type) } : {};
    const excludeFilter = req.query.excludeType
      ? { type: { not: String(req.query.excludeType) } }
      : {};

    const customers = await prisma.customer.findMany({
      where: { isActive: true, ...searchFilter, ...typeFilter, ...excludeFilter },
      orderBy: { name: "asc" },
      ...(limit ? { take: limit } : {}),
      // Include outstanding balance summary for directory display
      include: {
        sales: {
          where: { status: { in: ["PENDING", "PARTIAL"] } },
          select: { balance: true },
        },
      },
    });

    // Compute outstanding debt and strip the raw sales array from the response
    const directory = customers.map((c) => {
      const activeDebt = c.sales.reduce((sum, sale) => sum + sale.balance, 0);
      return {
        ...c,
        sales: undefined,
        activeDebt,
      };
    });

    res.status(200).json({
      message: "Directorio de clientes recuperado con éxito.",
      data: directory,
    });
  } catch (error: unknown) {
    res
      .status(500)
      .json({ error: "Fallo crítico al cargar la cartera de clientes." });
  }
};

// ============================================================================
// CREATE: Register a new customer or contractor
// ============================================================================
/**
 * POST /customers
 *
 * Creates a new customer. DNI/CUIT document is stored for identification.
 * Writes a `CUSTOMER_CREATE` audit log entry.
 */
export const createCustomer = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { name, document, type, phone, email, address } = req.body;

    // Reject duplicate document numbers (CUIT / DNI)
    if (document && document.trim() !== "") {
      const existingCustomer = await prisma.customer.findUnique({
        where: { document: document.trim() },
      });

      if (existingCustomer) {
        throw new Error(
          `Operación rechazada: Ya existe un perfil registrado con el documento/CUIT ${document}.`,
        );
      }
    }

    const newCustomer = await prisma.customer.create({
      data: {
        name,
        document: document || null,
        type: type || "CONSUMER",
        phone,
        email,
        address,
      },
    });

    await auditCustomerAction(
      authUser?.id,
      "customer.created",
      String(newCustomer.id),
      {
        name: newCustomer.name,
        document: newCustomer.document,
        type: newCustomer.type,
      },
    );

    res.status(201).json({
      message: "Perfil comercial incorporado al directorio exitosamente.",
      data: newCustomer,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "Error al registrar el perfil comercial.";
    res.status(400).json({ error: errorMsg });
  }
};

// ============================================================================
// UPDATE: Contact and profile data modification
// ============================================================================
/**
 * PUT /customers/:id
 *
 * Updates a customer's contact and identification data.
 * Writes a `CUSTOMER_UPDATE` audit log entry with a before/after snapshot.
 *
 * @param id - Customer ID.
 */
export const updateCustomer = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const customerId = Number(req.params.id);
    const data = req.body;
    const existingCustomer = await prisma.customer.findFirst({
      where: { id: customerId, isActive: true },
    });

    if (!existingCustomer) {
      return res.status(404).json({ error: "Cliente no encontrado." });
    }

    // Reject if the new document number already belongs to another customer
    if (data.document) {
      const existing = await prisma.customer.findFirst({
        where: {
          document: data.document,
          id: { not: customerId },
        },
      });
      if (existing)
        throw new Error(
          "El Documento/CUIT ingresado ya pertenece a otro cliente.",
        );
    }

    const updatedCustomer = await prisma.customer.update({
      where: { id: customerId },
      data,
    });

    await auditCustomerAction(authUser?.id, "customer.updated", String(customerId), {
      before: {
        name: existingCustomer.name,
        document: existingCustomer.document,
        type: existingCustomer.type,
      },
      after: {
        name: updatedCustomer.name,
        document: updatedCustomer.document,
        type: updatedCustomer.type,
      },
    });

    res.status(200).json({
      message: "Ficha del cliente actualizada correctamente.",
      data: updatedCustomer,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Fallo al actualizar el perfil.";
    res.status(400).json({ error: errorMsg });
  }
};

// ============================================================================
// SOFT DELETE: Archive customer without breaking accounting history
// ============================================================================
/**
 * DELETE /customers/:id
 *
 * Soft-deletes a customer (`isActive = false`). Customers with open balances
 * (pending sales) cannot be archived. Writes a `CUSTOMER_DELETE` audit entry.
 *
 * @param id - Customer ID.
 * Access: ADMIN only.
 */
export const deleteCustomer = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const customerId = Number(req.params.id);
    const customer = await prisma.customer.findFirst({
      where: { id: customerId, isActive: true },
    });

    if (!customer) {
      return res.status(404).json({ error: "Cliente no encontrado." });
    }

    // Block archival if the customer has open balances
    const pendingSales = await prisma.sale.findFirst({
      where: { customerId, status: { in: ["PENDING", "PARTIAL"] } },
    });

    if (pendingSales) {
      throw new Error(
        "Bloqueo de Seguridad: No se puede archivar un cliente que mantiene saldos pendientes de pago.",
      );
    }

    await prisma.customer.update({
      where: { id: customerId },
      data: { isActive: false },
    });

    await auditCustomerAction(authUser?.id, "customer.archived", String(customerId), {
      name: customer.name,
      document: customer.document,
      type: customer.type,
    });

    res
      .status(200)
      .json({ message: "Perfil comercial archivado de forma segura." });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Error al archivar el cliente.";
    res.status(400).json({ error: errorMsg });
  }
};

// ============================================================================
// CUSTOMER ACCOUNT STATEMENT — PDF
// ============================================================================
/**
 * GET /customers/:id/statement
 *
 * Generates a PDF account statement for the given customer showing all
 * pending and partial sales with their balances and payment history.
 * Accessible by ADMIN and ENCARGADO roles only.
 */
export const getCustomerStatement = async (
  req: AuthRequest,
  res: Response,
) => {
  try {
    const customerId = Number(req.params.id);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "ID de cliente inválido." });
    }

    const customer = await prisma.customer.findFirst({
      where: { id: customerId },
    });

    if (!customer) {
      return res.status(404).json({ error: "Cliente no encontrado." });
    }

    const pendingSales = await prisma.sale.findMany({
      where: {
        customerId,
        status: { in: ["PENDING", "PARTIAL"] },
      },
      include: {
        items: { include: { product: { select: { name: true, sku: true } } } },
        payments: { orderBy: { createdAt: "asc" } },
        branch: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const totalDebt = pendingSales.reduce((sum, s) => sum + s.balance, 0);

    const formatMoney = (n: number) =>
      `$${n.toLocaleString("es-AR", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

    const formatDate = (d: Date) =>
      new Date(d).toLocaleDateString("es-AR", {
        day: "2-digit", month: "2-digit", year: "numeric",
        timeZone: "America/Argentina/Buenos_Aires",
      });

    const pageHeight = Math.max(700, 350 + pendingSales.length * 80);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="estado-cuenta-${customer.name.replace(/\s+/g, "-")}.pdf"`,
    );

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    doc.pipe(res);

    // Header
    doc.fontSize(18).font("Helvetica-Bold").text("El Club de la Pintura", { align: "center" });
    doc.fontSize(10).font("Helvetica").text("Estado de Cuenta del Cliente", { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(8).text(`Emitido: ${formatDate(new Date())}`, { align: "right" });
    doc.moveDown(0.8);

    // Customer info
    doc.fontSize(12).font("Helvetica-Bold").text(customer.name);
    doc.fontSize(9).font("Helvetica");
    if (customer.document) doc.text(`Documento: ${customer.document}`);
    if (customer.phone) doc.text(`Teléfono: ${customer.phone}`);
    if (customer.type) doc.text(`Tipo: ${customer.type}`);
    if (customer.creditLimit > 0) {
      doc.text(`Límite de crédito: ${formatMoney(customer.creditLimit)}`);
      doc.text(`Crédito disponible: ${formatMoney(Math.max(0, customer.creditLimit - totalDebt))}`);
    }
    doc.moveDown(0.8);

    // Summary
    doc
      .fontSize(11)
      .font("Helvetica-Bold")
      .fillColor("#c2410c")
      .text(`SALDO TOTAL ADEUDADO: ${formatMoney(totalDebt)}`)
      .fillColor("black");
    doc.moveDown(0.5);

    // Sales detail
    if (pendingSales.length === 0) {
      doc.fontSize(10).font("Helvetica").text("Este cliente no tiene saldos pendientes.");
    } else {
      pendingSales.forEach((sale, idx) => {
        const paidAmount = sale.totalAmount - sale.balance;
        const daysPast = Math.floor(
          (Date.now() - new Date(sale.createdAt).getTime()) / 86_400_000,
        );

        doc.fontSize(9).font("Helvetica-Bold").text(
          `Ticket #${sale.id} — ${formatDate(sale.createdAt)} — ${sale.branch.name}`,
        );
        doc.font("Helvetica").text(
          `Total: ${formatMoney(sale.totalAmount)}  |  Cobrado: ${formatMoney(paidAmount)}  |  Saldo: ${formatMoney(sale.balance)}  |  Antigüedad: ${daysPast} días`,
        );

        if (sale.pickedUpBy) {
          doc.text(`Retiró: ${sale.pickedUpBy}`);
        }

        // Items summary (first 3)
        const displayItems = sale.items.slice(0, 3);
        displayItems.forEach((item) => {
          doc.text(`  · ${item.product.name} × ${item.quantity} = ${formatMoney(item.subtotal)}`, {
            indent: 10,
          });
        });
        if (sale.items.length > 3) {
          doc.text(`  · ...y ${sale.items.length - 3} ítem(s) más`, { indent: 10 });
        }

        if (idx < pendingSales.length - 1) {
          doc.moveDown(0.4);
          doc
            .moveTo(40, doc.y)
            .lineTo(555, doc.y)
            .strokeColor("#e5e7eb")
            .stroke();
          doc.moveDown(0.4);
        }
      });
    }

    doc.moveDown(2);
    doc.fontSize(9).font("Helvetica").fillColor("#6b7280");
    doc.text("Este documento es informativo e interno. No reemplaza factura fiscal.", { align: "center" });
    doc.text("─".repeat(80), { align: "center" });
    doc.text("Firma del cliente: ____________________________", { align: "center" });

    doc.end();

    void pageHeight; // suppress unused-var warning
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "Error al generar el estado de cuenta.";
    res.status(400).json({ error: errorMsg });
  }
};

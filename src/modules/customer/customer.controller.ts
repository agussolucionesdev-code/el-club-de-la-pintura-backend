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

    const customers = await prisma.customer.findMany({
      where: { isActive: true, ...searchFilter },
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

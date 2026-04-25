import { Prisma } from "@prisma/client";
import { Response } from "express";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

const toJsonPayload = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

const auditSupplierAction = async (
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
      entityType: "Supplier",
      entityId,
      metadata: toJsonPayload(metadata),
    },
  });
};

const sanitizePhone = (phone?: string | null) =>
  phone ? phone.replace(/[\s\-()]/g, "") : phone;

const parseLimit = (value: unknown) => {
  if (value === undefined || value === null || value === "") return 3000;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, 5000)
    : 3000;
};

const parseSupplierId = (value: unknown) => {
  const supplierId = Number(value);
  return Number.isInteger(supplierId) && supplierId > 0 ? supplierId : null;
};

export const getSuppliers = async (req: AuthRequest, res: Response) => {
  try {
    const limit = parseLimit(req.query.limit);
    const suppliers = await prisma.supplier.findMany({
      where: { isActive: true },
      orderBy: { companyName: "asc" },
      take: limit,
    });

    res.status(200).json({
      data: suppliers,
      meta: {
        count: suppliers.length,
        limit,
      },
    });
  } catch (error) {
    console.error("Error retrieving suppliers:", error);
    res
      .status(500)
      .json({ error: "Fallo al obtener el directorio de proveedores." });
  }
};

export const createSupplier = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const { companyName, cuit, contactName, phone, email, address } = req.body;
    const cleanCuit = cuit ? String(cuit).replace(/\D/g, "") : null;

    if (cleanCuit) {
      const existingSupplier = await prisma.supplier.findUnique({
        where: { cuit: cleanCuit },
      });
      if (existingSupplier) {
        return res
          .status(409)
          .json({ error: "Ya existe un proveedor registrado con este CUIT." });
      }
    }

    const newSupplier = await prisma.supplier.create({
      data: {
        companyName,
        cuit: cleanCuit,
        contactName: contactName || null,
        phone: sanitizePhone(phone) || "",
        email: email || null,
        address: address || null,
      },
    });

    await auditSupplierAction(authUser?.id, "supplier.created", String(newSupplier.id), {
      companyName: newSupplier.companyName,
      cuit: newSupplier.cuit,
    });

    res.status(201).json({
      message: "Proveedor registrado correctamente.",
      supplier: newSupplier,
    });
  } catch (error) {
    console.error("Error creating supplier:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al registrar el proveedor." });
  }
};

export const updateSupplier = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const supplierId = parseSupplierId(req.params.id);

    if (!supplierId) {
      return res.status(400).json({ error: "Proveedor invalido." });
    }

    const existingSupplier = await prisma.supplier.findFirst({
      where: { id: supplierId, isActive: true },
    });

    if (!existingSupplier) {
      return res.status(404).json({ error: "Proveedor no encontrado." });
    }

    const { companyName, cuit, contactName, phone, email, address } = req.body;
    const cleanCuit =
      cuit === undefined || cuit === null ? cuit : String(cuit).replace(/\D/g, "");

    if (cleanCuit) {
      const duplicate = await prisma.supplier.findFirst({
        where: {
          cuit: cleanCuit,
          id: { not: supplierId },
        },
      });

      if (duplicate) {
        return res
          .status(409)
          .json({ error: "Ya existe otro proveedor registrado con este CUIT." });
      }
    }

    const updatedSupplier = await prisma.supplier.update({
      where: { id: supplierId },
      data: {
        ...(companyName !== undefined ? { companyName } : {}),
        ...(cuit !== undefined ? { cuit: cleanCuit || null } : {}),
        ...(contactName !== undefined ? { contactName: contactName || null } : {}),
        ...(phone !== undefined ? { phone: sanitizePhone(phone) || "" } : {}),
        ...(email !== undefined ? { email: email || null } : {}),
        ...(address !== undefined ? { address: address || null } : {}),
      },
    });

    await auditSupplierAction(authUser?.id, "supplier.updated", String(supplierId), {
      before: {
        companyName: existingSupplier.companyName,
        cuit: existingSupplier.cuit,
        phone: existingSupplier.phone,
      },
      after: {
        companyName: updatedSupplier.companyName,
        cuit: updatedSupplier.cuit,
        phone: updatedSupplier.phone,
      },
    });

    res.status(200).json({
      message: "Proveedor actualizado correctamente.",
      supplier: updatedSupplier,
    });
  } catch (error) {
    console.error("Error updating supplier:", error);
    res
      .status(500)
      .json({ error: "No se pudo actualizar la ficha del proveedor." });
  }
};

export const deleteSupplier = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const supplierId = parseSupplierId(req.params.id);

    if (!supplierId) {
      return res.status(400).json({ error: "Proveedor invalido." });
    }

    const supplier = await prisma.supplier.findFirst({
      where: { id: supplierId, isActive: true },
    });

    if (!supplier) {
      return res.status(404).json({ error: "Proveedor no encontrado." });
    }

    const activeProducts = await prisma.product.count({
      where: { supplierId, isActive: true },
    });

    if (activeProducts > 0) {
      return res.status(409).json({
        error:
          "No se puede dar de baja el proveedor porque tiene productos activos asociados.",
        data: {
          blockers: {
            activeProducts,
          },
        },
      });
    }

    await prisma.supplier.update({
      where: { id: supplierId },
      data: { isActive: false },
    });

    await auditSupplierAction(authUser?.id, "supplier.archived", String(supplierId), {
      companyName: supplier.companyName,
      cuit: supplier.cuit,
    });

    res.status(200).json({
      message: "Proveedor dado de baja del sistema operativo correctamente.",
    });
  } catch (error) {
    console.error("Error deactivating supplier:", error);
    res
      .status(500)
      .json({ error: "No se pudo procesar la baja del proveedor." });
  }
};

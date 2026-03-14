import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// CONSOLIDAR LIBRO MAYOR: Obtener todos los clientes y su deuda total
// ============================================================================
export const retrieveCustomersLedger = async (req: Request, res: Response) => {
  try {
    const customers = await prisma.customer.findMany({
      include: {
        sales: {
          where: { status: { in: ["PENDING", "PARTIAL"] } },
          select: { balance: true, status: true, createdAt: true },
        },
      },
      orderBy: { name: "asc" },
    });

    const customersWithDebt = customers.map((customer) => {
      const totalConsolidatedDebt = customer.sales.reduce(
        (sum, sale) => sum + sale.balance,
        0,
      );
      return { ...customer, totalConsolidatedDebt };
    });

    res.status(200).json(customersWithDebt);
  } catch (error) {
    console.error("Error retrieving customers ledger:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al consultar el libro de clientes." });
  }
};

// ============================================================================
// EXPEDIENTE DE CLIENTE: Consultar historial de deuda y pagos de un individuo
// ============================================================================
export const retrieveCustomerProfile = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const customerProfile = await prisma.customer.findUnique({
      where: { id: Number(id) },
      include: {
        sales: {
          where: { status: { in: ["PENDING", "PARTIAL"] } }, // Solo facturas impagas
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!customerProfile) {
      return res.status(404).json({
        error: "El cliente solicitado no existe en la base de datos.",
      });
    }

    const totalConsolidatedDebt = customerProfile.sales.reduce(
      (sum, sale) => sum + sale.balance,
      0,
    );

    res.status(200).json({
      message: "Expediente financiero recuperado con éxito.",
      profile: customerProfile,
      financialStatus: {
        totalConsolidatedDebt,
        pendingInvoicesCount: customerProfile.sales.length,
        activeDebts: customerProfile.sales,
      },
    });
  } catch (error) {
    console.error("Error retrieving customer profile:", error);
    res
      .status(500)
      .json({ error: "Fallo al generar el expediente del cliente." });
  }
};

// ============================================================================
// REGISTRAR PERFIL: Dar de alta nuevo cliente, empresa o contratista
// ============================================================================
export const registerCustomerProfile = async (req: Request, res: Response) => {
  try {
    const { name, document, type, phone, email, address } = req.body;

    if (document) {
      const existingCustomer = await prisma.customer.findUnique({
        where: { document },
      });
      if (existingCustomer) {
        return res.status(400).json({
          error:
            "Conflicto: Ya existe un cliente registrado con este Documento/CUIT.",
        });
      }
    }

    const newCustomer = await prisma.customer.create({
      data: {
        name,
        document: document || null,
        type: type || "CONSUMER",
        phone: phone || null,
        email: email || null,
        address: address || null,
      },
    });

    res.status(201).json({
      message: "Perfil de cliente registrado correctamente.",
      customer: newCustomer,
    });
  } catch (error) {
    console.error("Error creating customer:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al registrar el nuevo perfil." });
  }
};

// ============================================================================
// MODIFICAR PERFIL: Actualizar datos de contacto o facturación
// ============================================================================
export const modifyCustomerProfile = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, document, type, phone, email, address } = req.body;

    const updatedCustomer = await prisma.customer.update({
      where: { id: Number(id) },
      data: { name, document, type, phone, email, address },
    });

    res.status(200).json({
      message: "Perfil actualizado con éxito.",
      customer: updatedCustomer,
    });
  } catch (error) {
    console.error("Error updating customer:", error);
    res.status(500).json({
      error:
        "Fallo al actualizar. Verifique el ID y restricciones de unicidad.",
    });
  }
};

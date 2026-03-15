import { Request, Response } from "express";
import prisma from "../../config/db";

// ============================================================================
// CONSOLIDAR LIBRO MAYOR: Obtener todos los clientes y su deuda total
// ============================================================================
export const retrieveCustomersLedger = async (req: Request, res: Response) => {
  try {
    const customers = await prisma.customer.findMany({
      where: { isActive: true }, // <-- INYECCIÓN: Solo traemos clientes activos
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

    // Cambiamos findUnique por findFirst para poder filtrar por isActive
    const customerProfile = await prisma.customer.findFirst({
      where: { id: Number(id), isActive: true }, // <-- INYECCIÓN: Previene operar con clientes archivados
      include: {
        sales: {
          where: { status: { in: ["PENDING", "PARTIAL"] } }, // Solo facturas impagas
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!customerProfile) {
      return res.status(404).json({
        error:
          "El cliente solicitado no existe o ha sido archivado del sistema.",
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
        // isActive es true por defecto en el schema
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

    // Verificamos que el cliente esté activo antes de modificarlo
    const activeCustomer = await prisma.customer.findFirst({
      where: { id: Number(id), isActive: true },
    });

    if (!activeCustomer) {
      return res.status(404).json({
        error: "No se puede modificar un cliente archivado o inexistente.",
      });
    }

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

// ============================================================================
// OCULTAR PERFIL: Baja lógica del cliente (Previene errores de integridad)
// ============================================================================
export const deactivateCustomerProfile = async (
  req: Request,
  res: Response,
) => {
  try {
    const { id } = req.params;

    // INYECCIÓN: Cambiamos a false en lugar de borrar físicamente
    await prisma.customer.update({
      where: { id: Number(id) },
      data: { isActive: false },
    });

    res.status(200).json({
      message:
        "Cliente archivado correctamente. Su historial financiero y deuda han sido preservados intactos en el sistema.",
    });
  } catch (error) {
    console.error("Error archivando cliente:", error);
    res
      .status(500)
      .json({ error: "Fallo estructural al intentar dar de baja al cliente." });
  }
};

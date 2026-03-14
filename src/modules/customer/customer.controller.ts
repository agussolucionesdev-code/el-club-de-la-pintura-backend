import { Request, Response } from "express";
import prisma from "../../config/db";

// Retrieve all customers with their pending balances (Digital Ledger / Cuadernito)
export const getCustomers = async (req: Request, res: Response) => {
  try {
    const customers = await prisma.customer.findMany({
      include: {
        // Fetch only sales that are not fully paid to calculate current debt
        sales: {
          where: { status: { in: ["PENDING", "PARTIAL"] } },
          select: { balance: true, status: true, createdAt: true },
        },
      },
      orderBy: { name: "asc" },
    });

    // Map customers to inject their calculated total debt
    const customersWithDebt = customers.map((customer) => {
      const totalDebt = customer.sales.reduce(
        (sum, sale) => sum + sale.balance,
        0,
      );
      return {
        ...customer,
        totalDebt,
      };
    });

    res.status(200).json(customersWithDebt);
  } catch (error) {
    console.error("Error retrieving customers:", error);
    res.status(500).json({ error: "Failed to retrieve the customer list." });
  }
};

// Register a new customer, contractor, or company
export const createCustomer = async (req: Request, res: Response) => {
  try {
    const { name, document, type, phone, email, address } = req.body;

    if (!name) {
      return res
        .status(400)
        .json({ error: "Customer name is strictly required." });
    }

    // Prevent duplicate documents (DNI/CUIT) if provided
    if (document) {
      const existingCustomer = await prisma.customer.findUnique({
        where: { document },
      });
      if (existingCustomer) {
        return res
          .status(400)
          .json({
            error: "A customer with this Document/CUIT already exists.",
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
      message: "Customer profile created successfully.",
      customer: newCustomer,
    });
  } catch (error) {
    console.error("Error creating customer:", error);
    res
      .status(500)
      .json({ error: "Structural failure while creating customer profile." });
  }
};

// Update existing customer details
export const updateCustomer = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, document, type, phone, email, address } = req.body;

    const updatedCustomer = await prisma.customer.update({
      where: { id: Number(id) },
      data: { name, document, type, phone, email, address },
    });

    res.status(200).json(updatedCustomer);
  } catch (error) {
    console.error("Error updating customer:", error);
    res
      .status(500)
      .json({
        error: "Failed to update customer. Verify ID and unique constraints.",
      });
  }
};

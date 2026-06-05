import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool as any);

const baseClient = new PrismaClient({ adapter });

/**
 * Extended Prisma client that converts Decimal fields to plain JS numbers on
 * every query result. This ensures existing controller arithmetic (+ - * / < >)
 * works without modification after the Float→Decimal schema migration.
 *
 * The DB stores values as DECIMAL (exact precision). Controllers receive numbers
 * (standard JS floats). The serialize middleware handles any leftover Decimals.
 */
const prisma = baseClient.$extends({
  result: {
    sale: {
      totalAmount: { needs: { totalAmount: true }, compute: (s) => Number(s.totalAmount) },
      balance:     { needs: { balance: true },     compute: (s) => Number(s.balance)     },
    },
    saleItem: {
      unitPrice: { needs: { unitPrice: true }, compute: (s) => Number(s.unitPrice) },
      subtotal:  { needs: { subtotal: true },  compute: (s) => Number(s.subtotal)  },
      unitCost:  { needs: { unitCost: true },  compute: (s) => s.unitCost !== null ? Number(s.unitCost) : null },
    },
    payment: {
      amount: { needs: { amount: true }, compute: (p) => Number(p.amount) },
    },
    expense: {
      amount: { needs: { amount: true }, compute: (e) => Number(e.amount) },
    },
    product: {
      costPrice:      { needs: { costPrice: true },      compute: (p) => p.costPrice      !== null ? Number(p.costPrice)      : null },
      profitMargin:   { needs: { profitMargin: true },   compute: (p) => Number(p.profitMargin)   },
      ivaPercentage:  { needs: { ivaPercentage: true },  compute: (p) => Number(p.ivaPercentage)  },
      retailPrice:    { needs: { retailPrice: true },    compute: (p) => p.retailPrice    !== null ? Number(p.retailPrice)    : null },
      wholesalePrice: { needs: { wholesalePrice: true }, compute: (p) => p.wholesalePrice !== null ? Number(p.wholesalePrice) : null },
    },
    cashRegister: {
      initialBalance:  { needs: { initialBalance: true },  compute: (c) => Number(c.initialBalance)  },
      expectedBalance: { needs: { expectedBalance: true }, compute: (c) => c.expectedBalance !== null ? Number(c.expectedBalance) : null },
      actualBalance:   { needs: { actualBalance: true },   compute: (c) => c.actualBalance   !== null ? Number(c.actualBalance)   : null },
      discrepancy:     { needs: { discrepancy: true },     compute: (c) => c.discrepancy     !== null ? Number(c.discrepancy)     : null },
    },
  },
});

export default prisma;

/**
 * Transaction client type derived from the extended prisma instance.
 * Use this instead of Prisma.TransactionClient in functions called inside
 * prisma.$transaction() callbacks when the extended client is in use.
 */
export type PrismaTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

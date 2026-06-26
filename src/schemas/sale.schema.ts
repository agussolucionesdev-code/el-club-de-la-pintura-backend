import { z } from "zod";

// Sale item sub-schema declaration
const saleItemSchema = z.object({
  productId: z.number().int().positive("Identificador de producto inválido."),
  quantity: z.number().positive("La cantidad debe ser mayor a cero."),
  unitPrice: z
    .number()
    .nonnegative("El precio unitario no puede ser negativo."),
  subtotal: z.number().nonnegative(),
  // Optional discount transparency for the printed ticket.
  listPrice: z.number().nonnegative().optional().nullable(),
  discountPct: z.number().min(0).max(100).optional().nullable(),
});

// All accepted payment method identifiers (CREDIT_ACCOUNT enables the store-credit / fiado flow)
const PAYMENT_METHODS = [
  "CASH",
  "DEBIT",
  "CREDIT",
  "TRANSFER",
  "MIXED",
  "CREDIT_ACCOUNT",
] as const;

const SALE_STATUS = ["PAID", "PENDING", "PARTIAL"] as const;

export const createSaleSchema = z.object({
  body: z.object({
    branchId: z.number().int().positive("La sucursal es obligatoria."),
    userId: z.number().int().positive("El usuario es obligatorio.").optional(),
    customerId: z.number().int().positive().optional().nullable(),
    cashRegisterId: z
      .number()
      .int()
      .positive("Debe haber una caja abierta para operar."),
    items: z
      .array(saleItemSchema)
      .min(1, "La venta debe contener al menos un producto."),
    totalAmount: z.number().positive("El monto total debe ser mayor a cero."),

    paymentMethod: z.enum(PAYMENT_METHODS, {
      message: "Método de pago no reconocido por el sistema.",
    }),

    status: z.enum(SALE_STATUS).default("PAID"),

    // pickedUpBy is required for store-credit sales to record who picked up the goods
    pickedUpBy: z.string().optional().nullable(),

    // Card reconciliation metadata (terminal is a separate Posnet; never the PAN)
    cardBrand: z.string().max(40).optional().nullable(),
    cardLast4: z.string().regex(/^\d{4}$/u, "Deben ser 4 dígitos.").optional().nullable(),
    cardInstallments: z.number().int().positive().max(120).optional().nullable(),
    cardSurchargePct: z.number().min(0).max(100).optional().nullable(),
    couponNumber: z.string().max(40).optional().nullable(),

    metadata: z.record(z.string(), z.any()).optional().nullable(),
  }),
});

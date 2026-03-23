import { z } from "zod";

// Declaración del Esquema de Ítems de Venta
const saleItemSchema = z.object({
  productId: z.number().int().positive("Identificador de producto inválido."),
  quantity: z.number().positive("La cantidad debe ser mayor a cero."),
  unitPrice: z
    .number()
    .nonnegative("El precio unitario no puede ser negativo."),
  subtotal: z.number().nonnegative(),
});

// 🛡️ CORRECCIÓN CLAVE: Agregamos CREDIT_ACCOUNT a la lista de métodos permitidos
const PAYMENT_METHODS = [
  "CASH",
  "DEBIT",
  "CREDIT",
  "TRANSFER",
  "MIXED",
  "CREDIT_ACCOUNT", // <-- ¡Acá está la magia!
] as const;

const SALE_STATUS = ["PAID", "PENDING", "PARTIAL"] as const;

export const createSaleSchema = z.object({
  body: z.object({
    branchId: z.number().int().positive("La sucursal es obligatoria."),
    userId: z.number().int().positive("El usuario es obligatorio."),
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

    // 🛡️ CORRECCIÓN CLAVE: Agregamos pickedUpBy para que Zod no lo rebote
    pickedUpBy: z.string().optional().nullable(),

    metadata: z.record(z.string(), z.any()).optional().nullable(),
  }),
});

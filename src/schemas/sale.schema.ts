import { z } from "zod";

// Declaración del Esquema de Ítems de Venta
// Definición de la estructura de cada producto dentro del carrito de compras
const saleItemSchema = z.object({
  productId: z.number().int().positive("Identificador de producto inválido."),
  quantity: z.number().positive("La cantidad debe ser mayor a cero."),
  // Captura del precio unitario en el momento de la transacción para histórico
  unitPrice: z
    .number()
    .nonnegative("El precio unitario no puede ser negativo."),
  // Subtotal calculado para validación cruzada
  subtotal: z.number().nonnegative(),
});

// Definición de constantes literales para evitar errores de inferencia en TS
const PAYMENT_METHODS = [
  "CASH",
  "DEBIT",
  "CREDIT",
  "TRANSFER",
  "MIXED",
] as const;
const SALE_STATUS = ["PAID", "PENDING", "PARTIAL"] as const;

// Declaración del Esquema Principal de Ventas
// Blindaje de la transacción comercial y su impacto en la contabilidad
export const createSaleSchema = z.object({
  body: z.object({
    // Relación con la sucursal física donde se realiza la operación
    branchId: z.number().int().positive("La sucursal es obligatoria."),

    // Identificación del operador (vendedor)
    userId: z.number().int().positive("El usuario es obligatorio."),

    // Relación con el cliente (opcional para consumidor final)
    customerId: z.number().int().positive().optional().nullable(),

    // Relación obligatoria con un turno de caja abierto
    cashRegisterId: z
      .number()
      .int()
      .positive("Debe haber una caja abierta para operar."),

    // Vector de productos (Carrito de compras)
    items: z
      .array(saleItemSchema)
      .min(1, "La venta debe contener al menos un producto."),

    // Cabecera financiera de la venta
    totalAmount: z.number().positive("El monto total debe ser mayor a cero."),

    // Corrección: Definición de la modalidad de pago usando la propiedad 'message' directamente
    paymentMethod: z.enum(PAYMENT_METHODS, {
      message: "Método de pago no reconocido por el sistema.",
    }),

    // Estado inicial de la transacción
    status: z.enum(SALE_STATUS).default("PAID"),

    // Metadatos adicionales (Ej: notas del vendedor, descuentos aplicados)
    metadata: z.record(z.string(), z.any()).optional().nullable(),
  }),
});

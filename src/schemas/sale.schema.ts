import { z } from "zod";

/**
 * Línea de venta.
 *
 * El cliente declara QUÉ quiere vender y CON QUÉ autorización. Los precios los
 * resuelve el servidor contra la base (`src/utils/pricing.utils.ts`).
 *
 * `unitPrice`, `subtotal` y `listPrice` siguen aceptándose por compatibilidad
 * con la app desplegada, pero **el servidor los ignora**: sólo el `totalAmount`
 * del cliente se usa, y únicamente para contrastar contra el total autoritativo
 * y rechazar la venta si difieren.
 */
const saleItemSchema = z.object({
  productId: z.number().int().positive("Identificador de producto inválido."),
  // Entero: no existe media lata de pintura. Antes `.positive()` aceptaba 2.5.
  quantity: z
    .number()
    .int("La cantidad debe ser un número entero de unidades.")
    .positive("La cantidad debe ser mayor a cero."),

  // Descuento de línea. El tope por rol se aplica en el servidor.
  discountPct: z.number().min(0).max(100).optional().nullable(),

  // Precio excepcional. Exige la capacidad correspondiente y queda auditado.
  priceOverride: z
    .number()
    .nonnegative("El precio excepcional no puede ser negativo.")
    .optional()
    .nullable(),

  // ── Compatibilidad: aceptados y descartados ──
  unitPrice: z.number().nonnegative().optional(),
  subtotal: z.number().nonnegative().optional(),
  listPrice: z.number().nonnegative().optional().nullable(),
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
    // El total que el operador VIO en pantalla. No define lo que se cobra: se
    // contrasta contra el total autoritativo y, si no coinciden, la venta se
    // rechaza con 409 para que el cajero revise el ticket actualizado.
    totalAmount: z.number().positive("El monto total debe ser mayor a cero."),

    // Efectivo entregado por el cliente. Se valida contra el COMPONENTE en
    // efectivo de la venta, no contra el total (importa en pagos mixtos).
    cashReceived: z.number().nonnegative().optional().nullable(),

    /**
     * Terminal declarada por el cliente.
     *
     * Se ACEPTA en el contrato pero **no se cree**: si la computadora tiene
     * credencial de dispositivo, esa gana, y si lo declarado la contradice la
     * venta se rechaza con `TERMINAL_MISMATCH`.
     *
     * Podría no declararse en absoluto —el `assignParsed` de este módulo lo
     * borraría y la credencial mandaría igual—, pero entonces un cliente
     * desincronizado creería haber declarado algo y el servidor lo ignoraría en
     * silencio. Preferimos aceptarlo y contradecirlo en voz alta.
     */
    terminalId: z.coerce.number().int().positive().optional().nullable(),

    paymentMethod: z.enum(PAYMENT_METHODS, {
      message: "Método de pago no reconocido por el sistema.",
    }),

    // Split payments (MIXED) or a partial down payment on a credit sale.
    // Domain rules (sum vs total, no CC inside the array) live in the controller.
    payments: z
      .array(
        z.object({
          paymentMethod: z.enum(PAYMENT_METHODS),
          amount: z.number().positive("Cada pago debe ser mayor a cero."),
        }),
      )
      .optional(),

    status: z.enum(SALE_STATUS).default("PAID"),

    // pickedUpBy is required for store-credit sales to record who picked up the goods
    pickedUpBy: z.string().optional().nullable(),

    // Optional free-text note printed on the ticket (e.g. "entregar 15hs")
    note: z.string().max(300).optional().nullable(),

    // Card reconciliation metadata (terminal is a separate Posnet; never the PAN)
    cardBrand: z.string().max(40).optional().nullable(),
    cardLast4: z.string().regex(/^\d{4}$/u, "Deben ser 4 dígitos.").optional().nullable(),
    cardInstallments: z.number().int().positive().max(120).optional().nullable(),
    cardSurchargePct: z.number().min(0).max(100).optional().nullable(),
    couponNumber: z.string().max(40).optional().nullable(),

    metadata: z.record(z.string(), z.any()).optional().nullable(),
  }),
});

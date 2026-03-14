import { z } from "zod";

// Aduana de Seguridad para el Movimiento Físico de Mercadería
export const updateStockSchema = z.object({
  body: z.object({
    productId: z.number().int().positive("El ID del producto debe ser válido."),
    branchId: z
      .number()
      .int()
      .positive("El ID de la sucursal debe ser válido."),
    // La cantidad final que va a quedar en la estantería
    quantity: z
      .number()
      .int()
      .nonnegative("La cantidad física no puede ser negativa."),

    // Auditoría estricta - CORREGIDO: Sintaxis actualizada de Zod
    type: z.enum(["IN", "OUT", "ADJUST"], {
      message: "El tipo de movimiento debe ser 'IN', 'OUT' o 'ADJUST'.",
    }),

    reason: z
      .string()
      .min(
        3,
        "Debe especificar un motivo claro para la auditoría (mínimo 3 caracteres).",
      ),

    // ==========================================
    // NUEVO: ACTUALIZACIÓN FINANCIERA AUTOMÁTICA
    // ==========================================
    // Si el proveedor mandó la mercadería con aumento, se carga acá
    newCostPrice: z
      .number()
      .nonnegative("El nuevo costo no puede ser negativo.")
      .optional()
      .nullable(),
  }),
});

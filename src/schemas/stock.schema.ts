import { z } from "zod";

// ==========================================
// VALIDATION: Inventory movement schema
// ==========================================
export const updateStockSchema = z.object({
  body: z.object({
    productId: z
      .number()
      .int()
      .positive("El ID del producto es obligatorio y debe ser válido."),
    branchId: z.number().int().positive("El ID de la sucursal es obligatorio."),

    // userId is passed from the frontend for movement audit trail
    userId: z
      .number()
      .int()
      .positive("El ID del usuario es obligatorio para la auditoría.")
      .optional(),

    quantity: z
      .number()
      .nonnegative("La cantidad a ajustar no puede ser negativa."),

    type: z.enum(["ADD", "SUBTRACT", "SET"], {
      message: "Comando inválido. Debe ser ADD, SUBTRACT o SET.",
    }),

    reason: z.string().max(255, "La razón es demasiado larga.").optional(),
  }),
});

// ==========================================
// VALIDATION: Stock alert threshold schema
// ==========================================
export const updateStockThresholdsSchema = z.object({
  body: z.object({
    productId: z.number().int().positive("El ID del producto es obligatorio."),
    branchId: z.number().int().positive("El ID de la sucursal es obligatorio."),
    minStock: z.number().nonnegative("El umbral mínimo no puede ser negativo."),
  }),
});

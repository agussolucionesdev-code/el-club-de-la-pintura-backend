import { z } from "zod";

// ==========================================
// VALIDACIÓN: Movimientos de Inventario
// ==========================================
export const updateStockSchema = z.object({
  body: z.object({
    productId: z
      .number()
      .int()
      .positive("El ID del producto es obligatorio y debe ser válido."),
    branchId: z.number().int().positive("El ID de la sucursal es obligatorio."),
    quantity: z
      .number()
      .nonnegative("La cantidad a ajustar no puede ser negativa."),

    // CORRECCIÓN: Usamos 'message' directamente para el enum
    type: z.enum(["ADD", "SUBTRACT", "SET"], {
      message: "Comando inválido. Debe ser ADD, SUBTRACT o SET.",
    }),

    reason: z.string().max(255, "La razón es demasiado larga.").optional(),
  }),
});

// ==========================================
// VALIDACIÓN: Configuración de Alertas
// ==========================================
export const updateStockThresholdsSchema = z.object({
  body: z.object({
    productId: z.number().int().positive("El ID del producto es obligatorio."),
    branchId: z.number().int().positive("El ID de la sucursal es obligatorio."),
    minStock: z.number().nonnegative("El umbral mínimo no puede ser negativo."),
  }),
});

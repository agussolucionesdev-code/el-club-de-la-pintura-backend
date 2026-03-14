import { z } from "zod";

// Aduana de Seguridad para el Movimiento Físico de Mercadería
export const updateStockSchema = z.object({
  body: z.object({
    productId: z.number().int().positive("El ID del producto debe ser válido."),
    branchId: z
      .number()
      .int()
      .positive("El ID de la sucursal debe ser válido."),
    quantity: z
      .number()
      .int()
      .nonnegative("La cantidad física no puede ser negativa."),
    type: z.enum(["IN", "OUT", "ADJUST"], {
      message: "El tipo de movimiento debe ser 'IN', 'OUT' o 'ADJUST'.",
    }),
    reason: z
      .string()
      .min(
        3,
        "Debe especificar un motivo claro para la auditoría (mínimo 3 caracteres).",
      ),
    newCostPrice: z
      .number()
      .nonnegative("El nuevo costo no puede ser negativo.")
      .optional()
      .nullable(),
  }),
});

// NUEVO: Aduana para Configuración del Semáforo Dinámico
export const updateStockThresholdsSchema = z.object({
  body: z
    .object({
      productId: z
        .number()
        .int()
        .positive("El ID del producto debe ser válido."),
      branchId: z
        .number()
        .int()
        .positive("El ID de la sucursal debe ser válido."),
      minStock: z
        .number()
        .int()
        .nonnegative("El límite amarillo no puede ser negativo."),
      criticalStock: z
        .number()
        .int()
        .nonnegative("El límite rojo no puede ser negativo."),
    })
    .refine((data) => data.minStock > data.criticalStock, {
      message:
        "Error lógico: El nivel Amarillo (minStock) debe ser estrictamente mayor al Rojo (criticalStock).",
      path: ["minStock"], // Apunta el error al campo responsable
    }),
});

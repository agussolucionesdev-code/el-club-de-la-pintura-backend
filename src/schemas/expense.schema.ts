import { z } from "zod";

// Validar registro de salidas de dinero de la caja
export const registerExpenseSchema = z.object({
  body: z.object({
    amount: z.number().positive("El monto del gasto debe ser mayor a cero."),
    reason: z
      .string()
      .min(
        3,
        "Debe especificar un motivo claro (ej: 'Compra artículos limpieza').",
      ),
    category: z
      .string()
      .min(2, "La categoría es obligatoria (ej: 'LIMPIEZA', 'VIATICOS')."),

    // NUEVO: Barrera de validación para clasificación contable
    type: z.enum(["FIXED", "VARIABLE"], {
      message:
        "El tipo de gasto debe ser obligatoriamente 'FIXED' o 'VARIABLE'.",
    }),

    branchId: z.number().int().positive("La sucursal es obligatoria."),
  }),
});

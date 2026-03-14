import { z } from "zod";

// Validación estricta para la Apertura de Caja
export const openShiftSchema = z.object({
  body: z.object({
    branchId: z
      .number()
      .int()
      .positive("El identificador de la sucursal es obligatorio."),
    initialBalance: z
      .number()
      .nonnegative(
        "El fondo de caja (sencillo) no puede ser un valor negativo.",
      ),
  }),
});

// Validación estricta para el Cierre de Caja (Arqueo)
export const closeShiftSchema = z.object({
  body: z.object({
    actualBalance: z
      .number()
      .nonnegative("El dinero físico contado no puede ser negativo."),
    observations: z.string().optional().nullable(),
  }),
});

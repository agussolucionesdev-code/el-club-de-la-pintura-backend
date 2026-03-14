import { z } from "zod";

export const dashboardFilterSchema = z.object({
  query: z.object({
    branchId: z.string().regex(/^\d+$/, "El ID debe ser un número.").optional(),
    startDate: z.string().datetime().optional(),
    endDate: z.string().datetime().optional(),
    // NUEVO: Permiso para el ranking dinámico
    limit: z
      .string()
      .regex(/^\d+$/, "El límite debe ser un número entero.")
      .optional(),
  }),
});

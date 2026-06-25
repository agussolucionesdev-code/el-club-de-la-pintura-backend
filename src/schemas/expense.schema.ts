import { z } from "zod";

export const registerExpenseSchema = z.object({
  body: z.object({
    amount: z.number().positive("El monto debe ser mayor a cero."),
    reason: z.string().min(3, "Debe especificar un motivo claro."),
    category: z.string().min(2, "La categoría es obligatoria."),
    type: z.enum(["FIXED", "VARIABLE"]),
    branchId: z.number().int().positive(),

    // Optional: attached receipt (Cloudinary URL) and supplier link
    receiptImageUrl: z.string().url().optional().nullable(),
    supplierId: z.number().int().positive().optional().nullable(),

    // cashRegisterId is required — Zod strips unknown keys by default
    cashRegisterId: z
      .number()
      .int()
      .positive("Falta el identificador de la registradora."),
  }),
});

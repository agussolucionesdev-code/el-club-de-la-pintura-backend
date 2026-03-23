import { z } from "zod";

export const registerExpenseSchema = z.object({
  body: z.object({
    amount: z.number().positive("El monto debe ser mayor a cero."),
    reason: z.string().min(3, "Debe especificar un motivo claro."),
    category: z.string().min(2, "La categoría es obligatoria."),
    type: z.enum(["FIXED", "VARIABLE"]),
    branchId: z.number().int().positive(),

    // 🛡️ SI ESTO NO ESTÁ, ZOD BORRA EL ID Y EXPLOTA TODO
    cashRegisterId: z
      .number()
      .int()
      .positive("Falta el identificador de la registradora."),
  }),
});

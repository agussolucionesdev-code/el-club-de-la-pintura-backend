import { z } from "zod";

export const createCustomerSchema = z.object({
  body: z.object({
    name: z.string().min(2, "El nombre del cliente/empresa es obligatorio."),
    document: z.string().optional().nullable(),
    type: z
      .enum(["CONSUMER", "CONTRACTOR", "COMPANY", "FAMILY"])
      .optional()
      .default("CONSUMER"),
    phone: z.string().optional().nullable(),
    email: z
      .string()
      .email("Formato de correo inválido.")
      .optional()
      .nullable(),
    address: z.string().optional().nullable(),
  }),
});

import { z } from "zod";

export const createCustomerSchema = z.object({
  body: z.object({
    name: z
      .string()
      .min(2, "El nombre de la empresa o titular es obligatorio."),
    document: z.string().optional(), // DNI or CUIT (Argentine tax IDs)
    type: z
      .enum(["CONSUMER", "CONTRACTOR", "COMPANY", "FAMILY", "INTERNAL"], {
        message: "El perfil comercial seleccionado no es válido.",
      })
      .default("CONSUMER"),
    phone: z.string().optional(),
    email: z
      .string()
      .email("El formato del correo electrónico es inválido.")
      .optional()
      .or(z.literal("")),
    address: z.string().optional(),
  }),
});

export const updateCustomerSchema = z.object({
  body: z.object({
    name: z.string().min(2).optional(),
    document: z.string().optional(),
    type: z.enum(["CONSUMER", "CONTRACTOR", "COMPANY", "FAMILY", "INTERNAL"]).optional(),
    phone: z.string().optional(),
    email: z.string().email().optional().or(z.literal("")),
    address: z.string().optional(),
  }),
});

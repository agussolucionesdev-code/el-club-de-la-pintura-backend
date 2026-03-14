import { z } from "zod";

export const createSupplierSchema = z.object({
  body: z.object({
    companyName: z
      .string()
      .min(2, "El nombre de la empresa proveedora es obligatorio."),
    cuit: z.string().optional().nullable(),
    contactName: z.string().optional().nullable(),
    // Exigimos el teléfono porque es el puente para la automatización de pedidos
    phone: z
      .string()
      .min(
        8,
        "El número de teléfono es obligatorio para los pedidos por WhatsApp.",
      ),
    email: z
      .string()
      .email("Formato de correo inválido.")
      .optional()
      .nullable(),
    address: z.string().optional().nullable(),
  }),
});

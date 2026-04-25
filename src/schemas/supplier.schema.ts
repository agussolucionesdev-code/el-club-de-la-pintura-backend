import { z } from "zod";

const optionalTrimmedString = z
  .string()
  .trim()
  .optional()
  .nullable()
  .transform((value) => (value === "" ? null : value));

const optionalEmail = z
  .string()
  .trim()
  .email("Formato de correo invalido.")
  .optional()
  .nullable()
  .transform((value) => (value === "" ? null : value));

export const createSupplierSchema = z.object({
  body: z.object({
    companyName: z
      .string()
      .trim()
      .min(2, "El nombre de la empresa proveedora es obligatorio."),
    cuit: optionalTrimmedString,
    contactName: optionalTrimmedString,
    phone: z
      .string()
      .trim()
      .min(8, "El numero de telefono es obligatorio para pedidos y contacto."),
    email: optionalEmail,
    address: optionalTrimmedString,
  }),
});

export const updateSupplierSchema = z.object({
  body: z.object({
    companyName: z
      .string()
      .trim()
      .min(2, "El nombre de la empresa proveedora es obligatorio.")
      .optional(),
    cuit: optionalTrimmedString,
    contactName: optionalTrimmedString,
    phone: z
      .string()
      .trim()
      .min(8, "El numero de telefono debe tener al menos 8 caracteres.")
      .optional(),
    email: optionalEmail,
    address: optionalTrimmedString,
  }),
});

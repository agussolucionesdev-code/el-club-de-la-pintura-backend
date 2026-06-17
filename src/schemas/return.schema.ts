import { z } from "zod";

// Each returned line references a SaleItem and the quantity being given back.
const returnItemSchema = z.object({
  saleItemId: z
    .coerce.number()
    .int()
    .positive("Identificador de ítem de venta inválido."),
  quantity: z.coerce
    .number()
    .int()
    .positive("La cantidad a devolver debe ser mayor a cero."),
});

export const createReturnSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive("ID de venta inválido."),
  }),
  body: z.object({
    reason: z
      .string()
      .trim()
      .min(5, "El motivo de la devolución debe tener al menos 5 caracteres."),
    items: z
      .array(returnItemSchema)
      .min(1, "Debe indicar al menos un ítem a devolver."),
  }),
});

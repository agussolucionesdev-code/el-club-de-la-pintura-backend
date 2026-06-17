import { z } from "zod";

// Structural guard for account/debt collection payments. The domain enum for
// `paymentMethod` is enforced in the controller (parseAccountPaymentMethod);
// here we only ensure the field is present and the amounts/ids are coercible.
export const registerAccountPaymentSchema = z.object({
  body: z.object({
    saleId: z.coerce
      .number()
      .int()
      .positive("Ticket de origen inválido."),
    amount: z.coerce
      .number()
      .positive("El importe del cobro debe ser mayor a cero."),
    paymentMethod: z
      .string()
      .min(1, "El método de pago es obligatorio."),
    cashRegisterId: z.coerce
      .number()
      .int()
      .positive("Debe haber un turno de caja abierto para cobrar."),
  }),
});

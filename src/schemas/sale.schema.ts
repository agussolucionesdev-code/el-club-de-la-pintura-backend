import { z } from "zod";

// Declaración del Esquema de Ventas (Shopping Cart)
// Tipado fuerte para la prevención de inyección de datos corruptos en la facturación
export const createSaleSchema = z.object({
  body: z.object({
    branchId: z
      .number()
      .int()
      .positive("El identificador de la sucursal es inválido."),
    paymentMethod: z.enum([
      "EFECTIVO",
      "TARJETA",
      "TRANSFERENCIA",
      "MERCADOPAGO",
    ]),
    items: z
      .array(
        z.object({
          productId: z.number().int().positive(),
          quantity: z
            .number()
            .int()
            .positive("La cantidad a vender debe ser mayor a cero."),
          unitPrice: z
            .number()
            .positive("El precio unitario no puede ser negativo o cero."),
        }),
      )
      .min(
        1,
        "El carrito de compras no puede estar vacío para procesar una venta.",
      ),
  }),
});

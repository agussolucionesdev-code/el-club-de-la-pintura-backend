import { z } from "zod";

const cashDenominationSchema = z.object({
  denomination: z
    .number()
    .positive("La denominacion debe ser mayor a cero."),
  quantity: z
    .number()
    .int("La cantidad de billetes/monedas debe ser entera.")
    .nonnegative("La cantidad de billetes/monedas no puede ser negativa."),
});

export const openShiftSchema = z.object({
  body: z.object({
    branchId: z
      .number()
      .int()
      .positive("El identificador de la sucursal es obligatorio."),
    initialBalance: z
      .number()
      .nonnegative(
        "El fondo de caja (sencillo) no puede ser un valor negativo.",
      ),
  }),
});

export const closeShiftSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive("El identificador de caja es invalido."),
  }),
  body: z.object({
    actualBalance: z
      .number()
      .nonnegative("El dinero físico contado no puede ser negativo."),
    observations: z.string().optional().nullable(),
    localPendingOperations: z.number().int().nonnegative().optional(),
    localFailedOperations: z.number().int().nonnegative().optional(),
    denominationBreakdown: z.array(cashDenominationSchema).optional(),
  }),
});

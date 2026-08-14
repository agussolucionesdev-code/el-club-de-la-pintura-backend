import { z } from "zod";

const monto = z
  .number()
  .positive("El monto debe ser mayor a cero.")
  .max(99_999_999, "El monto es demasiado grande.");

/**
 * El motivo es OBLIGATORIO en todo lo que mueve plata de una persona.
 *
 * No es burocracia: seis meses después, "¿por qué me descontaron $12.000?" tiene
 * que tener respuesta sin depender de que alguien se acuerde. Un ajuste sin
 * motivo es indistinguible de un error.
 */
const motivo = z
  .string()
  .trim()
  .min(4, "Escribí el motivo: sin eso, dentro de seis meses nadie sabe por qué.")
  .max(300, "El motivo no puede superar los 300 caracteres.");

export const createInternalConsumptionSchema = z.object({
  body: z
    .object({
      kind: z.enum(["EMPLOYEE_PERSONAL", "COMPANY_USE"]),
      branchId: z.coerce.number().int().positive("La sucursal es obligatoria."),
      cashRegisterId: z.coerce.number().int().positive().optional().nullable(),

      /** Sólo para EMPLOYEE_PERSONAL: de quién es la deuda. */
      userId: z.coerce.number().int().positive().optional().nullable(),
      /** Sólo para COMPANY_USE: para qué se usó. */
      purpose: z.string().trim().max(200).optional().nullable(),

      pricePolicy: z
        .enum(["RETAIL", "COST", "COST_PLUS", "STAFF_DISCOUNT", "EXPLICIT"])
        .default("RETAIL"),
      pricePolicyRate: z.number().min(0).max(100).optional().nullable(),

      items: z
        .array(
          z.object({
            productId: z.number().int().positive(),
            // Entero: no existe media lata. Mismo criterio que una venta.
            quantity: z
              .number()
              .int("La cantidad debe ser un número entero de unidades.")
              .positive("La cantidad debe ser mayor a cero."),
            /** Sólo con política EXPLICIT, y exige capacidad de aprobación. */
            explicitPrice: z.number().nonnegative().optional().nullable(),
          }),
        )
        .min(1, "Tiene que haber al menos un producto."),

      reason: motivo.optional().nullable(),
    })
    // Las dos clases piden datos distintos, y confundirlas es el bug que este
    // modelo viene a evitar: un consumo de la empresa que le genere deuda a
    // alguien, o un consumo personal que no se la genere a nadie.
    .refine((b) => b.kind !== "EMPLOYEE_PERSONAL" || b.userId != null, {
      message: "Un consumo personal necesita saber de quién es.",
      path: ["userId"],
    })
    .refine((b) => b.kind !== "COMPANY_USE" || Boolean(b.purpose?.trim()), {
      message: "Un uso de la empresa necesita decir para qué fue.",
      path: ["purpose"],
    })
    .refine(
      (b) =>
        !["COST_PLUS", "STAFF_DISCOUNT"].includes(b.pricePolicy) ||
        b.pricePolicyRate != null,
      {
        message: "Esa política de precio necesita el porcentaje.",
        path: ["pricePolicyRate"],
      },
    ),
});

export const createStaffPaymentSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z
    .object({
      method: z.enum([
        "CASH",
        "TRANSFER",
        "PAYROLL_DEDUCTION",
        "MERCHANDISE_RETURN",
        "WRITE_OFF",
      ]),
      amount: monto,
      /** Obligatorio SÓLO en efectivo: es lo único que entra al cajón. */
      cashRegisterId: z.coerce.number().int().positive().optional().nullable(),
      reference: z.string().trim().max(80).optional().nullable(),
      reason: motivo.optional().nullable(),
    })
    .refine((b) => b.method !== "CASH" || b.cashRegisterId != null, {
      message: "Un pago en efectivo tiene que entrar a una caja abierta.",
      path: ["cashRegisterId"],
    })
    // Condonar es regalar plata de la empresa. Sin motivo escrito, no.
    .refine((b) => b.method !== "WRITE_OFF" || Boolean(b.reason?.trim()), {
      message: "Condonar una deuda exige explicar por qué.",
      path: ["reason"],
    }),
});

export const createStaffAdjustmentSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    direction: z.enum(["DEBIT", "CREDIT"]),
    amount: monto,
    reason: motivo,
  }),
});

export const listStaffLedgerSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  query: z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
});

// ── Traslado legado ────────────────────────────────────────────────────────

export const proposeLegacyLinkSchema = z.object({
  body: z.object({
    legacyCustomerId: z.coerce.number().int().positive(),
    userId: z.coerce.number().int().positive("Elegí a quién pertenece esta cuenta."),
    reason: motivo,
  }),
});

export const confirmLegacyTransferSchema = z.object({
  params: z.object({ id: z.coerce.number().int().positive() }),
  body: z.object({
    // Trasladar la deuda de una persona exige decir por qué, sin excepción:
    // es la única forma de que la decisión se pueda revisar después.
    reason: motivo,
  }),
});

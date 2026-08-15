import { z } from "zod";

const dinero = z.number().finite().nonnegative();
const porcentaje = z.number().finite().min(0).max(100);

/**
 * Una regla del plan.
 *
 * El refinamiento es lo importante: una regla a la que le falta su campo
 * esencial —un porcentaje sin porcentaje, una meta sin monto— pasaría la
 * validación de forma y reventaría recién al calcular la comisión de alguien.
 * Se rechaza al cargarla, que es cuando todavía hay alguien mirando la pantalla.
 */
const reglaSchema = z
  .object({
    kind: z.enum(["PERCENT_OF_SALES", "TIERED_PERCENT", "FIXED_ON_TARGET"]),
    percent: porcentaje.nullish(),
    fromAmount: dinero.nullish(),
    toAmount: dinero.nullish(),
    fixedAmount: dinero.nullish(),
    targetAmount: dinero.nullish(),
  })
  .superRefine((regla, ctx) => {
    if (regla.kind === "PERCENT_OF_SALES" || regla.kind === "TIERED_PERCENT") {
      if (regla.percent == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["percent"],
          message: "Una regla por porcentaje necesita el porcentaje.",
        });
      }
    }
    if (regla.kind === "TIERED_PERCENT") {
      if (regla.fromAmount == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fromAmount"],
          message: "Un escalón necesita desde qué monto aplica.",
        });
      }
      if (
        regla.fromAmount != null &&
        regla.toAmount != null &&
        regla.toAmount <= regla.fromAmount
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["toAmount"],
          message: "El fin del escalón tiene que ser mayor que su inicio.",
        });
      }
    }
    if (regla.kind === "FIXED_ON_TARGET") {
      if (regla.fixedAmount == null || regla.targetAmount == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fixedAmount"],
          message: "Un premio por meta necesita el monto y la meta.",
        });
      }
    }
  });

export const createIncentivePlanSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(1).max(120),
      cadence: z.enum(["WEEKLY", "BIWEEKLY", "MONTHLY"]).default("MONTHLY"),
      /**
       * La decisión que el negocio todavía no cerró: cuándo se gana la comisión.
       * `MIXED` es el default porque es el único que no paga comisión sobre plata
       * que no entró.
       */
      eligibilityPolicy: z
        .enum(["ON_SALE", "ON_COLLECTION", "MIXED"])
        .default("MIXED"),
      minMarginPct: porcentaje.nullish(),
      effectiveFrom: z.coerce.date(),
      rules: z
        .array(reglaSchema)
        .min(1, "El plan necesita al menos una regla."),
    })
    .superRefine((plan, ctx) => {
      const tipos = new Set(plan.rules.map((r) => r.kind));
      // Mezclar familias haría que el resultado dependa del orden de evaluación,
      // y "cuánto gano" no puede depender de en qué orden se cargaron las reglas.
      if (tipos.size > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules"],
          message:
            "Todas las reglas del plan tienen que ser del mismo tipo: " +
            "porcentaje plano, escalones, o premio por meta.",
        });
      }

      const escalones = plan.rules
        .filter((r) => r.kind === "TIERED_PERCENT")
        .sort((a, b) => (a.fromAmount ?? 0) - (b.fromAmount ?? 0));
      for (let i = 0; i < escalones.length - 1; i += 1) {
        const actual = escalones[i]!;
        const siguiente = escalones[i + 1]!;
        if (actual.toAmount == null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["rules"],
            message: "Sólo el último escalón puede ser abierto.",
          });
          break;
        }
        // Un hueco entre escalones deja base sin comisionar en silencio; un
        // solape la comisiona dos veces. Las dos son plata mal calculada.
        if (actual.toAmount !== siguiente.fromAmount) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["rules"],
            message:
              `Los escalones tienen que encadenarse sin huecos: ` +
              `uno termina en ${actual.toAmount} y el siguiente arranca en ${siguiente.fromAmount}.`,
          });
          break;
        }
      }
    }),
});

export const calculatePeriodSchema = z.object({
  body: z.object({
    planId: z.number().int().positive(),
    /** "2026-08", "2026-08-Q1" o "2026-W33", según la cadencia del plan. */
    key: z
      .string()
      .regex(
        /^\d{4}-(\d{2}(-Q[12])?|W\d{2})$/u,
        'Clave de período inválida. Se espera "2026-08", "2026-08-Q1" o "2026-W33".',
      ),
  }),
});

export const transitionPeriodSchema = z.object({
  body: z.object({
    to: z.enum(["CALCULATED", "REVIEWED", "APPROVED", "LOCKED", "PAID"]),
  }),
});

export const setSalesTargetSchema = z.object({
  body: z.object({
    periodId: z.number().int().positive(),
    userId: z.number().int().positive(),
    branchId: z.number().int().positive().nullish(),
    targetAmount: dinero,
  }),
});

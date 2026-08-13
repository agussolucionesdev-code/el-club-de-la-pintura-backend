import { z } from "zod";

/**
 * El código es la etiqueta que el personal dice en voz alta ("893-CAJA-01").
 * Se acota el alfabeto a propósito: entra en un cartel, se dicta por teléfono
 * sin ambigüedad y no admite caracteres que compliquen una URL o un log.
 */
const terminalCode = z
  .string()
  .trim()
  .min(3, "El código debe tener al menos 3 caracteres.")
  .max(30, "El código no puede superar los 30 caracteres.")
  .regex(
    /^[A-Za-z0-9-]+$/u,
    "El código sólo admite letras, números y guiones (ej: 893-CAJA-01).",
  );

const terminalName = z
  .string()
  .trim()
  .min(2, "El nombre debe tener al menos 2 caracteres.")
  .max(60, "El nombre no puede superar los 60 caracteres.");

export const createTerminalSchema = z.object({
  body: z.object({
    code: terminalCode,
    name: terminalName,
    branchId: z.coerce.number().int().positive("La sucursal es obligatoria."),
  }),
});

export const updateTerminalSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive("ID de terminal inválido."),
  }),
  body: z
    .object({
      name: terminalName.optional(),
      branchId: z.coerce.number().int().positive().optional(),
      status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
    })
    .refine((body) => Object.keys(body).length > 0, {
      message: "No hay nada para actualizar.",
    }),
});

export const enrollDeviceSchema = z.object({
  body: z.object({
    // El token se genera con `randomBytes(24).toString("base64url")` → 32
    // caracteres del alfabeto base64url. Acotarlo evita guardar basura y frena
    // intentos de inyección por esta vía.
    token: z
      .string()
      .trim()
      .min(16, "El token de enrolamiento es demasiado corto.")
      .max(128, "El token de enrolamiento es demasiado largo.")
      .regex(/^[A-Za-z0-9_-]+$/u, "El token tiene caracteres inválidos."),
  }),
});

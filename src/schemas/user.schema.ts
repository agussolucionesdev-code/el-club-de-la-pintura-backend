import { z } from "zod";

export const registerUserSchema = z.object({
  body: z
    .object({
      name: z.string().min(2, "El nombre debe tener al menos 2 caracteres."),
      email: z.string().email("El formato del correo electrónico es inválido."),
      password: z
        .string()
        .min(
          6,
          "La contraseña debe contener un mínimo de 6 caracteres de seguridad.",
        ),
      role: z
        .enum(["ADMIN", "ENCARGADO", "EMPLOYEE"])
        .optional()
        .default("EMPLOYEE"),
      // CAMBIO MULTI-SUCURSAL: Esperamos un array de IDs en lugar de un único número
      branchIds: z.array(z.number().int().positive()).optional(),
      adminSecret: z.string().optional(),
    })
    .refine(
      (data) => {
        if (data.role === "ADMIN") {
          return (
            data.adminSecret !== undefined && data.adminSecret.trim() !== ""
          );
        }
        return true;
      },
      {
        message:
          "Se requiere la Llave Maestra para registrar un perfil de Alta Gerencia (ADMIN).",
        path: ["adminSecret"],
      },
    )
    .refine(
      (data) => {
        // Exigimos que el array exista y tenga al menos 1 elemento
        if (data.role !== "ADMIN") {
          return data.branchIds !== undefined && data.branchIds.length > 0;
        }
        return true;
      },
      {
        message:
          "Los perfiles operativos deben pertenecer a al menos un local físico obligatoriamente (branchIds).",
        path: ["branchIds"],
      },
    ),
});

import { z } from "zod";

// ============================================================================
// ONBOARDING: Validación para dar de alta a un nuevo empleado
// ============================================================================
export const onboardEmployeeSchema = z.object({
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
      branchIds: z.array(z.number().int().positive()).optional(),
      adminSecret: z.string().optional(),
    })
    .refine(
      (data) =>
        data.role === "ADMIN"
          ? data.adminSecret !== undefined && data.adminSecret.trim() !== ""
          : true,
      {
        message:
          "Se requiere la Llave Maestra para registrar un perfil de Alta Gerencia (ADMIN).",
        path: ["adminSecret"],
      },
    )
    .refine(
      (data) =>
        data.role !== "ADMIN"
          ? data.branchIds !== undefined && data.branchIds.length > 0
          : true,
      {
        message:
          "Los perfiles operativos deben pertenecer a al menos un local físico obligatoriamente.",
        path: ["branchIds"],
      },
    ),
});

// ============================================================================
// MODIFY: Validación para editar el rol o sucursal de un empleado existente
// ============================================================================
export const modifyEmployeeSchema = z.object({
  body: z
    .object({
      name: z.string().min(2, "El nombre debe tener al menos 2 caracteres."),
      email: z.string().email("El formato del correo electrónico es inválido."),
      role: z.enum(["ADMIN", "ENCARGADO", "EMPLOYEE"]),
      branchIds: z.array(z.number().int().positive()).optional().default([]),
    })
    .refine((data) => data.role === "ADMIN" || data.branchIds.length > 0, {
      message: "Debe asignar al menos una sucursal a perfiles operativos.",
      path: ["branchIds"],
    }),
});

// ============================================================================
// RESET PASSWORD: Validación exclusiva para blanquear claves olvidadas
// ============================================================================
export const resetPasswordSchema = z.object({
  body: z.object({
    newPassword: z
      .string()
      .min(6, "La nueva contraseña debe contener un mínimo de 6 caracteres."),
  }),
});

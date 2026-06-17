import { z } from "zod";

// salaryType is a free string in the schema (FIXED | HOURLY | COMMISSION);
// the controller defaults it to "FIXED" when absent.
export const createEmployeeSchema = z.object({
  body: z.object({
    userId: z.coerce.number().int().positive("El usuario es obligatorio."),
    position: z.string().min(1, "El puesto es obligatorio."),
    salaryType: z.string().optional().nullable(),
    baseSalary: z.coerce
      .number()
      .nonnegative("El sueldo base no puede ser negativo."),
    branchId: z.coerce.number().int().positive("La sucursal es obligatoria."),
  }),
});

export const updateEmployeeSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive("Identificador de empleado inválido."),
  }),
  body: z.object({
    position: z.string().min(1).optional(),
    salaryType: z.string().optional().nullable(),
    baseSalary: z.coerce.number().nonnegative().optional(),
    branchId: z.coerce.number().int().positive().optional(),
    isActive: z.boolean().optional(),
  }),
});

export const createPayrollRecordSchema = z.object({
  body: z.object({
    employeeId: z.coerce
      .number()
      .int()
      .positive("El empleado es obligatorio."),
    period: z
      .string()
      .regex(/^\d{4}-\d{2}$/, "El período debe tener formato YYYY-MM."),
    advances: z.coerce.number().nonnegative().optional().default(0),
    bonuses: z.coerce.number().nonnegative().optional().default(0),
    deductions: z.coerce.number().nonnegative().optional().default(0),
    observations: z.string().optional().nullable(),
  }),
});

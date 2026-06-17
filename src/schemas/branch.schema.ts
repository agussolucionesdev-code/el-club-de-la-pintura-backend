import { z } from "zod";

// Shared body shape for create/update. `location` is optional and nullable
// because branches may be registered before a physical address is known.
const branchBody = z.object({
  name: z.string().min(2, "El nombre de la sucursal es obligatorio."),
  location: z.string().optional().nullable(),
});

export const createBranchSchema = z.object({
  body: branchBody,
});

export const updateBranchSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive("Identificador de sucursal inválido."),
  }),
  body: branchBody,
});

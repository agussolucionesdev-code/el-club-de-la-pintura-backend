import { z } from "zod";

export const createProductSchema = z.object({
  body: z.object({
    sku: z.string().min(3, "El SKU debe tener al menos 3 caracteres."),
    barcode: z.string().optional().nullable(),
    name: z.string().min(2, "El nombre del producto es obligatorio."),
    brand: z.string().min(1, "La marca es obligatoria."),
    category: z.string().min(1, "La categoría es obligatoria."),
    description: z.string().optional().nullable(),

    // Refactored financial core fields
    costPrice: z.number().nonnegative().optional().nullable(),
    profitMargin: z.number().nonnegative().optional().default(30.0),
    ivaPercentage: z.number().nonnegative().max(100).optional().default(21.0),
    retailPrice: z.number().nonnegative().optional().nullable(),
    wholesalePrice: z.number().nonnegative().optional().nullable(),

    color: z.string().optional().nullable(),
    finish: z.string().optional().nullable(),
    volume: z.number().positive().optional().nullable(),
    volumeUnit: z.string().optional().nullable(),
    indoorOutdoor: z.boolean().optional().default(true),
    baseType: z.string().optional().nullable(),
    images: z.array(z.string()).optional().default([]),
    stock: z.number().nonnegative().optional().nullable(),
    stockBranchId: z.number().int().positive().optional().nullable(),
    branchId: z.number().int().positive().optional().nullable(),
    status: z.string().optional().nullable(),
    metadata: z.record(z.string(), z.any()).optional().nullable(),
    supplierId: z.number().int().positive().optional().nullable(),
  }),
});

// Update accepts any subset of the editable fields (partial). The route param
// `id` identifies the product; the controller resolves and persists the diff.
// Numeric fields are coerced because the edit form may submit them as strings.
export const updateProductSchema = z.object({
  params: z.object({
    id: z.coerce.number().int().positive("Identificador de producto inválido."),
  }),
  body: z.object({
    sku: z.string().min(3, "El SKU debe tener al menos 3 caracteres.").optional(),
    barcode: z.string().optional().nullable(),
    name: z.string().min(2, "El nombre del producto es obligatorio.").optional(),
    brand: z.string().min(1).optional(),
    category: z.string().min(1).optional(),
    description: z.string().optional().nullable(),
    costPrice: z.coerce.number().nonnegative().optional().nullable(),
    profitMargin: z.coerce.number().nonnegative().optional(),
    ivaPercentage: z.coerce.number().nonnegative().max(100).optional(),
    retailPrice: z.coerce.number().nonnegative().optional().nullable(),
    wholesalePrice: z.coerce.number().nonnegative().optional().nullable(),
    color: z.string().optional().nullable(),
    finish: z.string().optional().nullable(),
    volume: z.coerce.number().positive().optional().nullable(),
    volumeUnit: z.string().optional().nullable(),
    indoorOutdoor: z.boolean().optional(),
    baseType: z.string().optional().nullable(),
    images: z.array(z.string()).optional(),
    stock: z.coerce.number().nonnegative().optional().nullable(),
    stockBranchId: z.coerce.number().int().positive().optional().nullable(),
    branchId: z.coerce.number().int().positive().optional().nullable(),
    status: z.string().optional().nullable(),
    metadata: z.record(z.string(), z.any()).optional().nullable(),
    supplierId: z.coerce.number().int().positive().optional().nullable(),
  }),
});

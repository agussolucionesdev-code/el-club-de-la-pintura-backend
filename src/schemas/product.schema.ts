import { z } from "zod";

// Declaración del Esquema de Productos
// Blindaje de datos del catálogo, variables financieras y relaciones de aprovisionamiento
export const createProductSchema = z.object({
  body: z.object({
    // Identificadores lógicos y físicos
    sku: z.string().min(3, "El SKU debe tener al menos 3 caracteres."),
    barcode: z.string().optional().nullable(),

    // Clasificación base
    name: z.string().min(2, "El nombre del producto es obligatorio."),
    brand: z.string().min(1, "La marca es obligatoria."),
    category: z.string().min(1, "La categoría es obligatoria."),
    description: z.string().optional().nullable(),

    // Núcleo Financiero (Opcionales, pero si se envían deben ser números positivos)
    costPrice: z
      .number()
      .nonnegative("El costo no puede ser negativo.")
      .optional()
      .nullable(),
    retailPrice: z
      .number()
      .nonnegative("El precio minorista no puede ser negativo.")
      .optional()
      .nullable(),
    wholesalePrice: z
      .number()
      .nonnegative("El precio mayorista no puede ser negativo.")
      .optional()
      .nullable(),
    ivaPercentage: z.number().min(0).max(100).optional().default(21.0),

    // Atributos específicos de la industria pinturera
    color: z.string().optional().nullable(),
    finish: z.string().optional().nullable(),
    volume: z
      .number()
      .positive("El volumen debe ser mayor a 0.")
      .optional()
      .nullable(),
    volumeUnit: z.string().optional().nullable(),
    indoorOutdoor: z.boolean().optional().default(true),
    baseType: z.string().optional().nullable(),

    // ==========================================
    // NUEVO: RELACIÓN LOGÍSTICA (PROVEEDORES)
    // ==========================================
    supplierId: z
      .number()
      .int("El identificador del proveedor debe ser un número entero.")
      .positive("El identificador del proveedor debe ser positivo.")
      .optional()
      .nullable(),
  }),
});

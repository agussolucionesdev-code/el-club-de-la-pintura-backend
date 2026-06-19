import { z } from "zod";

// A purchase line: product + quantity, with an optional unit cost override.
const purchaseItemSchema = z.object({
  productId: z.coerce
    .number()
    .int()
    .positive("Los items de compra contienen productos inválidos."),
  quantity: z.coerce
    .number()
    .int()
    .positive("Los items de compra contienen datos inválidos."),
  unitCost: z.coerce
    .number()
    .nonnegative("El costo unitario de compra no es válido.")
    .optional()
    .nullable(),
});

const purchaseBody = z.object({
  branchId: z.coerce.number().int().positive("La sucursal es obligatoria."),
  supplierId: z.coerce.number().int().positive().optional().nullable(),
  items: z
    .array(purchaseItemSchema)
    .min(1, "La compra debe incluir al menos un producto."),
});

export const createPurchaseOrderSchema = z.object({
  body: purchaseBody,
});

export const receivePurchaseReceiptSchema = z.object({
  body: purchaseBody.extend({
    // Optional link to an existing purchase order being fulfilled.
    // PurchaseOrder.id is a UUID string (not numeric); the controller treats an
    // empty string as "no linked order".
    purchaseOrderId: z.string().optional().nullable(),
    reason: z.string().optional().nullable(),
  }),
});

import { z } from "zod";

// Offline sync push. Operations carry heterogeneous, versioned payloads that
// the controller reconciles individually, so we only guard the envelope shape:
// a branch scope and an array of operation objects. Over-constraining here
// would risk rejecting valid offline batches from older client versions.
export const pushSyncSchema = z.object({
  body: z.object({
    branchId: z.coerce.number().int().positive().optional().nullable(),
    deviceId: z.string().optional().nullable(),
    operations: z
      .array(z.object({}).passthrough(), {
        message: "El lote de sincronización debe ser una lista de operaciones.",
      })
      .optional(),
  }),
});

import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { pushSyncSchema } from "../../schemas/sync.schema";
import {
  getSyncStatus,
  pullSyncSnapshot,
  confirmAttribution,
  listPendingAttribution,
  pushSyncOperations,
} from "./sync.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"));

router.get("/pull", pullSyncSnapshot);
router.get("/status", getSyncStatus);
router.post("/push", validate(pushSyncSchema), pushSyncOperations);

// Revisión de atribuciones que el sistema no pudo verificar solo. La
// autorización va por capacidad, adentro del controlador.
router.get("/pending-attribution", listPendingAttribution);
router.post("/pending-attribution/:id/confirm", confirmAttribution);

export default router;

import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import {
  getSyncStatus,
  pullSyncSnapshot,
  pushSyncOperations,
} from "./sync.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"));

router.get("/pull", pullSyncSnapshot);
router.get("/status", getSyncStatus);
router.post("/push", pushSyncOperations);

export default router;

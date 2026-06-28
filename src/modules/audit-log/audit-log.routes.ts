import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { listAuditLogs } from "./audit-log.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN"));

router.get("/", listAuditLogs);

export default router;

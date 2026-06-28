import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { listAuditLogs, migrationsDiag } from "./audit-log.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN"));

router.get("/", listAuditLogs);
router.get("/_migrations-diag", migrationsDiag);

export default router;

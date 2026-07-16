import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { getAlertsSummary } from "./alerts.controller";

const router = Router();

router.use(authenticateToken);

// Open to every role: the controller nulls out the blocks a role cannot act on.
router.get("/summary", getAlertsSummary);

export default router;

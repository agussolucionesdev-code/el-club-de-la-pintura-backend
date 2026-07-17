import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { getSettings, updateSettings } from "./settings.controller";

const router = Router();

router.use(authenticateToken);

// Read is open: the UI needs these to know what to render.
router.get("/", getSettings);

// Only the owner changes how the shop behaves.
router.put("/", authorizeRoles("ADMIN"), updateSettings);

export default router;

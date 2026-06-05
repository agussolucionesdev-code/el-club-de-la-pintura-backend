import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { authorizeInvoice, getLastAuthorizedNumber, getAfipStatus } from "./afip.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO"));

router.get("/status", getAfipStatus);
router.get("/last-number/:type/:pos", getLastAuthorizedNumber);
router.post("/authorize", authorizeInvoice);

export default router;

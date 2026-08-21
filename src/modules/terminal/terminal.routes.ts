import { Router } from "express";

import { authenticateToken, requireFullAuth } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  createTerminalSchema,
  enrollDeviceSchema,
  updateTerminalSchema,
} from "../../schemas/terminal.schema";
import {
  createTerminal,
  enrollDevice,
  issueEnrollmentToken,
  listTerminals,
  revokeTerminalDevice,
  updateTerminal,
  whoAmI,
} from "./terminal.controller";

const router = Router();

router.use(authenticateToken);

// Qué terminal es esta computadora. La responde cualquiera que opere el POS:
// el cajero necesita ver en pantalla en qué caja está parado.
router.get("/me", whoAmI);

// Canje del token por la credencial. NO exige ser admin: el token ya es la
// autorización —lo emitió un admin— y quien enrola suele ser el encargado
// parado frente a la máquina. Igual se valida acceso a la sucursal.
router.post("/enroll", validate(enrollDeviceSchema, { assignParsed: true }), enrollDevice);

// ── Administración: sólo dueño y encargados ──
router.get("/", authorizeRoles("ADMIN", "ENCARGADO"), listTerminals);

router.post(
  "/",
  authorizeRoles("ADMIN"),
  validate(createTerminalSchema, { assignParsed: true }),
  createTerminal,
);

router.patch(
  "/:id",
  authorizeRoles("ADMIN"),
  validate(updateTerminalSchema, { assignParsed: true }),
  updateTerminal,
);

router.post("/:id/enrollment", authorizeRoles("ADMIN"), requireFullAuth, issueEnrollmentToken);
router.post("/:id/revoke", authorizeRoles("ADMIN"), requireFullAuth, revokeTerminalDevice);

export default router;

import { Router } from "express";

import { authenticateToken } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  confirmLegacyTransferSchema,
  createInternalConsumptionSchema,
  createStaffAdjustmentSchema,
  createStaffPaymentSchema,
  listStaffLedgerSchema,
  proposeLegacyLinkSchema,
} from "../../schemas/staff.schema";
import {
  createInternalConsumption,
  listInternalConsumptions,
} from "./internalConsumption.controller";
import {
  confirmLegacyTransfer,
  listLegacyCandidates,
  proposeLegacyLink,
  reverseLegacyTransfer,
} from "./legacyTransfer.controller";
import {
  createStaffAdjustment,
  createStaffPayment,
  getMyStaffAccount,
  getStaffLedger,
  listStaffAccounts,
} from "./staff.controller";

const router = Router();

/**
 * ⚠️ La autenticación va RUTA POR RUTA, nunca con `router.use()`.
 *
 * Este router se monta en `/api` porque su contrato usa rutas de la raíz
 * (`/staff-accounts`, `/internal-consumptions`, `/legacy-links`). Un
 * `router.use(authenticateToken)` acá corre para TODO request que entre por
 * `/api`, incluso los que no matchean ninguna ruta de este archivo y siguen de
 * largo hacia los otros routers. El resultado es que `POST /api/users/login`
 * —que por definición todavía no tiene sesión— muere con 401 y la aplicación
 * entera se queda sin poder iniciar sesión.
 *
 * Escribí exactamente este bug en `pos-auth.routes.ts`, lo arreglé, lo dejé
 * documentado ahí… y lo volví a cometer acá. Lo agarraron los tests de
 * integración las dos veces. Por eso la advertencia está en los dos archivos:
 * sirve donde está el peligro, no en otro lado.
 */

/**
 * Sin `authorizeRoles` en las rutas de lectura, a propósito.
 *
 * El alcance NO es por rol: es por capacidad y por a quién pertenece la cuenta.
 * Un EMPLOYEE entra acá legítimamente —a ver lo suyo— y el controlador acota
 * qué ve. Poner un guard de rol en la puerta habría dejado afuera al principal
 * destinatario de esta pantalla: la persona que quiere saber cuánto debe.
 */

// Lo propio primero: la ruta literal antes que la del parámetro.
router.get("/staff-accounts/me", authenticateToken, getMyStaffAccount);
router.get("/staff-accounts", authenticateToken, listStaffAccounts);
router.get(
  "/staff-accounts/:id/ledger",
  authenticateToken,
  validate(listStaffLedgerSchema),
  getStaffLedger,
);

// ── Mutaciones ──
// La capacidad se verifica en el controlador, donde además se conoce de quién
// es la cuenta: "puede cobrar" y "puede condonar" no son el mismo permiso.
router.post(
  "/staff-accounts/:id/payments",
  authenticateToken,
  validate(createStaffPaymentSchema, { assignParsed: true }),
  createStaffPayment,
);

router.post(
  "/staff-accounts/:id/adjustments",
  authenticateToken,
  validate(createStaffAdjustmentSchema, { assignParsed: true }),
  createStaffAdjustment,
);

// ── Consumo interno ──
router.get("/internal-consumptions", authenticateToken, listInternalConsumptions);
router.post(
  "/internal-consumptions",
  authenticateToken,
  validate(createInternalConsumptionSchema, { assignParsed: true }),
  createInternalConsumption,
);

// ══════════════════════════════════════════════════════════════════════════
// TRASLADO LEGADO
// ══════════════════════════════════════════════════════════════════════════
//
// Proponer y confirmar están separados a propósito: la decisión de a quién se
// le cobra una deuda vieja tiene que poder mirarse dos veces antes de mover
// plata.
//
// Revertir exige una capacidad DISTINTA (`staff:adjust`, no
// `staff:transfer_legacy`), porque deshacer no es lo mismo que hacer.
router.get("/legacy-links", authenticateToken, listLegacyCandidates);

router.post(
  "/legacy-links",
  authenticateToken,
  validate(proposeLegacyLinkSchema, { assignParsed: true }),
  proposeLegacyLink,
);

router.post(
  "/legacy-links/:id/confirm",
  authenticateToken,
  validate(confirmLegacyTransferSchema, { assignParsed: true }),
  confirmLegacyTransfer,
);

router.post(
  "/legacy-links/:id/reverse",
  authenticateToken,
  validate(confirmLegacyTransferSchema, { assignParsed: true }),
  reverseLegacyTransfer,
);

export default router;

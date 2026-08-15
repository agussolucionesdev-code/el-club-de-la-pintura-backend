import { Router } from "express";

import { authenticateToken } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  calculatePeriodSchema,
  createIncentivePlanSchema,
  setSalesTargetSchema,
  transitionPeriodSchema,
} from "../../schemas/incentive.schema";
import {
  calculateIncentivePeriod,
  createIncentivePlan,
  getMyIncentives,
  getPeriodPerformance,
  listIncentivePlans,
  setSalesTarget,
  transitionPeriod,
} from "./incentive.controller";

const router = Router();

/**
 * ⚠️ La autenticación va RUTA POR RUTA, nunca con `router.use()`.
 *
 * Este router se monta en `/api` porque su contrato usa rutas de la raíz
 * (`/incentive-plans`, `/incentive-periods`). Un `router.use(authenticateToken)`
 * acá corre para TODO request que entre por `/api`, incluso los que no matchean
 * ninguna ruta de este archivo y siguen de largo hacia los otros routers. El
 * resultado es que `POST /api/users/login` empieza a exigir el token que el
 * usuario todavía no tiene, y se cae el login de la aplicación entera.
 *
 * Ya pasó dos veces en este proyecto —en `pos-auth.routes.ts` y en
 * `staff.routes.ts`— y las dos veces lo cazaron los tests de integración, no la
 * revisión. Por eso el aviso está repetido en cada archivo que corre el riesgo.
 */

// ── Planes y reglas ──
router.get("/incentive-plans", authenticateToken, listIncentivePlans);
router.post(
  "/incentive-plans",
  authenticateToken,
  validate(createIncentivePlanSchema),
  createIncentivePlan,
);

// ── Cálculo y liquidación ──
router.post(
  "/incentive-periods/calculate",
  authenticateToken,
  validate(calculatePeriodSchema),
  calculateIncentivePeriod,
);
router.get("/incentive-periods/:key/performance", authenticateToken, getPeriodPerformance);
router.post(
  "/incentive-periods/:id/transition",
  authenticateToken,
  validate(transitionPeriodSchema),
  transitionPeriod,
);

// ── Metas ──
router.post(
  "/incentive-targets",
  authenticateToken,
  validate(setSalesTargetSchema),
  setSalesTarget,
);

// ── Lo propio ──
router.get("/incentives/me", authenticateToken, getMyIncentives);

export default router;

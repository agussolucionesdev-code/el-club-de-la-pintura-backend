import { Router } from "express";
import rateLimit from "express-rate-limit";

import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  activatePosPinSchema,
  openOperatorSessionSchema,
  resetOtherPosPinSchema,
  revealPosPinSchema,
  setPosPinSchema,
} from "../../schemas/posPin.schema";
import {
  activatePin,
  disableMyPin,
  getMyPinStatus,
  resetOtherPin,
  revealMyPin,
  setMyPin,
} from "./posPin.controller";
import {
  closeCurrentOperatorSession,
  getCurrentOperatorSession,
  listTerminalOperators,
  openOperatorSession,
} from "./posSession.controller";

const router = Router();

/**
 * ⚠️ Este router se monta en `/api`, no en un prefijo propio, porque su
 * contrato incluye rutas de la raíz (`/me/pos-pin`, `/users/:id/pos-pin/reset`).
 *
 * Por eso la autenticación va **ruta por ruta** y NUNCA con `router.use()`.
 *
 * Un `router.use(authenticateToken)` acá corre para TODO request que entre por
 * `/api`, incluso los que no matchean ninguna ruta de este archivo y siguen de
 * largo hacia los otros routers. Eso significaba que `POST /api/users/login`
 * —que por definición todavía no tiene sesión— moría con 401 antes de llegar a
 * su controlador. Toda la aplicación quedaba sin poder iniciar sesión.
 *
 * Lo agarraron los tests de integración de los otros módulos. No es teórico.
 */

/**
 * Límite para las rutas que consumen un secreto.
 *
 * El bloqueo por PIN vive en la credencial (5 fallos → 15 minutos) y es por
 * USUARIO. Esto es la otra mitad: por ORIGEN, para que probar contra muchos
 * usuarios distintos desde la misma máquina tampoco salga gratis.
 */
const secretoRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Demasiados intentos desde esta conexión. Esperá unos minutos.",
  },
});

// ══════════════════════════════════════════════════════════════════════════
// ACTIVACIÓN — la única ruta sin sesión iniciada
// ══════════════════════════════════════════════════════════════════════════
//
// Quien recibe la credencial de activación puede estar parado frente a la
// computadora del mostrador sin haber entrado nunca al sistema. La credencial
// ES la autorización: por eso vive 24 horas y se consume al primer uso.
router.post(
  "/pos-pin/activate",
  secretoRateLimiter,
  validate(activatePosPinSchema, { assignParsed: true }),
  activatePin,
);

// ══════════════════════════════════════════════════════════════════════════
// PIN PROPIO
// ══════════════════════════════════════════════════════════════════════════
//
// Sin restricción de rol a propósito: **todos** tienen PIN, incluido el dueño.
// Si el dueño quedara exento, sus ventas se seguirían atribuyendo por el token
// y volveríamos al problema original — con el agravante de que las suyas son
// las que más pesan en cualquier reporte.

router.get("/me/pos-pin", authenticateToken, getMyPinStatus);

router.put(
  "/me/pos-pin",
  authenticateToken,
  secretoRateLimiter,
  validate(setPosPinSchema, { assignParsed: true }),
  setMyPin,
);

// POST y NO GET: un GET queda en el historial del navegador, en los logs del
// proxy y en cualquier caché intermedia. Un secreto no viaja en una URL.
router.post(
  "/me/pos-pin/reveal",
  authenticateToken,
  secretoRateLimiter,
  validate(revealPosPinSchema, { assignParsed: true }),
  revealMyPin,
);

router.delete("/me/pos-pin", authenticateToken, secretoRateLimiter, disableMyPin);

// ══════════════════════════════════════════════════════════════════════════
// RESTABLECER EL PIN DE OTRO
// ══════════════════════════════════════════════════════════════════════════
//
// Exige ROL, no capacidad de POS: es una acción administrativa, y una sesión de
// PIN no la habilita ni aunque el operador sea ADMIN. Para esto hay que entrar
// con la cuenta y la contraseña.
//
// **No existe —ni va a existir— un endpoint que devuelva el PIN de otra
// persona.** Ni para el dueño. Lo único que se puede hacer es emitir una
// credencial de activación para que su dueño elija uno nuevo.
router.post(
  "/users/:id/pos-pin/reset",
  authenticateToken,
  authorizeRoles("ADMIN", "ENCARGADO"),
  validate(resetOtherPosPinSchema, { assignParsed: true }),
  resetOtherPin,
);

// ══════════════════════════════════════════════════════════════════════════
// SESIÓN DE OPERADOR (F10)
// ══════════════════════════════════════════════════════════════════════════

router.get("/pos/terminal/operators", authenticateToken, listTerminalOperators);
router.get("/pos/operator-sessions/current", authenticateToken, getCurrentOperatorSession);

router.post(
  "/pos/operator-sessions",
  authenticateToken,
  secretoRateLimiter,
  validate(openOperatorSessionSchema, { assignParsed: true }),
  openOperatorSession,
);

router.post(
  "/pos/operator-sessions/current/close",
  authenticateToken,
  closeCurrentOperatorSession,
);

export default router;

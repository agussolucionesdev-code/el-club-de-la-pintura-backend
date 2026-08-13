import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeBranchAccess } from "../../middlewares/branch.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import { createSaleSchema } from "../../schemas/sale.schema";
import {
  getSales,
  getSaleById,
  createSale,
  getPendingAccounts,
  exportPendingAccountsExcel,
  generateSaleReceiptPdf,
  cancelSale,
  getDiscountCode,
  generateDiscountCode,
  validateDiscountCode,
} from "./sale.controller";

const router = Router();

router.use(authenticateToken, authorizeRoles("ADMIN", "ENCARGADO", "EMPLOYEE"));

router.get(
  "/pending/:branchId",
  authorizeBranchAccess({ allowAllBranches: true }),
  getPendingAccounts,
);
router.get(
  "/pending-export/excel",
  authorizeRoles("ADMIN", "ENCARGADO"),
  exportPendingAccountsExcel,
);
// Ticket-discount authorization code — registered BEFORE "/:id" so the
// literal path never gets swallowed by the param route.
router.get("/discount-code", authorizeRoles("ADMIN", "ENCARGADO"), getDiscountCode);
router.post("/discount-code/generate", authorizeRoles("ADMIN", "ENCARGADO"), generateDiscountCode);
router.post("/discount-code/validate", validateDiscountCode);

router.get("/", getSales);
router.get("/:id/receipt/pdf", generateSaleReceiptPdf);
router.post("/:id/cancel", authorizeRoles("ADMIN", "ENCARGADO"), cancelSale);
router.get("/:id", getSaleById);
// `assignParsed: true` — PRIMER módulo migrado al contrato corregido de Zod.
//
// Hasta ahora el middleware validaba y descartaba el resultado, así que las
// claves no declaradas llegaban intactas al controlador. Por eso `createSale`
// podía leer `item.unitCost`, un campo que este schema ni menciona.
//
// Con esto activado, el cuerpo que llega al controlador es EXACTAMENTE el que
// el schema declara: un `unitCost` inyectado se descarta en el borde, no en la
// lógica de negocio. Es defensa en profundidad sobre el arreglo de la Fase 2.
//
// Se habilita sólo acá, y no en los otros 14 módulos, porque 11 de ellos usan
// `.default()` o `z.coerce` que hoy NO se aplican: activarlos de golpe cambiaría
// su comportamiento sin verificación. Ver validate.middleware.ts.
router.post(
  "/",
  authorizeBranchAccess(),
  validate(createSaleSchema, { assignParsed: true }),
  createSale,
);

export default router;

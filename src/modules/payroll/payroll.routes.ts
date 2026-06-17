/**
 * Payroll Routes — employee salary management.
 *
 * All routes require authentication. ADMIN and ENCARGADO can access all endpoints.
 * Non-admin users can still read their own branch data via the controller-level filter.
 *
 * @module payroll.routes
 */

import { Router } from "express";
import { authenticateToken } from "../../middlewares/auth.middleware";
import { authorizeRoles } from "../../middlewares/role.middleware";
import { validate } from "../../middlewares/validate.middleware";
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  createPayrollRecordSchema,
} from "../../schemas/payroll.schema";
import {
  getEmployees,
  createEmployee,
  updateEmployee,
  getRecords,
  createRecord,
  markAsPaid,
  getPayrollReceiptPdf,
} from "./payroll.controller";

const router = Router();

// All payroll routes require authentication
router.use(authenticateToken);

// Employee management — ADMIN only for mutations, ADMIN/ENCARGADO for reads
router.get("/employees", authorizeRoles("ADMIN", "ENCARGADO"), getEmployees);
router.post("/employees", authorizeRoles("ADMIN"), validate(createEmployeeSchema), createEmployee);
router.patch("/employees/:id", authorizeRoles("ADMIN"), validate(updateEmployeeSchema), updateEmployee);

// Payroll record management
router.get("/records", authorizeRoles("ADMIN", "ENCARGADO"), getRecords);
router.post("/records", authorizeRoles("ADMIN", "ENCARGADO"), validate(createPayrollRecordSchema), createRecord);
router.patch("/records/:id/pay", authorizeRoles("ADMIN", "ENCARGADO"), markAsPaid);

// Payroll receipt PDF — available for PAID records
router.get("/records/:id/pdf", authorizeRoles("ADMIN", "ENCARGADO"), getPayrollReceiptPdf);

export default router;

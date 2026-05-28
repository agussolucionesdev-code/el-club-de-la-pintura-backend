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
import {
  getEmployees,
  createEmployee,
  getRecords,
  createRecord,
  markAsPaid,
} from "./payroll.controller";

const router = Router();

// All payroll routes require authentication
router.use(authenticateToken);

// Employee management — ADMIN only for mutations, ADMIN/ENCARGADO for reads
router.get("/employees", authorizeRoles("ADMIN", "ENCARGADO"), getEmployees);
router.post("/employees", authorizeRoles("ADMIN"), createEmployee);

// Payroll record management
router.get("/records", authorizeRoles("ADMIN", "ENCARGADO"), getRecords);
router.post("/records", authorizeRoles("ADMIN", "ENCARGADO"), createRecord);
router.patch("/records/:id/pay", authorizeRoles("ADMIN", "ENCARGADO"), markAsPaid);

export default router;

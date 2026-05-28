/**
 * Payroll Controller — employee salary management.
 *
 * Endpoints:
 *   GET  /payroll/employees               — list all employees (ADMIN sees all; others see own branch)
 *   POST /payroll/employees               — register a user as an employee
 *   GET  /payroll/records?period=YYYY-MM  — list payroll records for a period
 *   POST /payroll/records                 — create a new payroll record
 *   PATCH /payroll/records/:id/pay        — mark a record as PAID
 *
 * @module payroll.controller
 */

import { Response } from "express";
import { Decimal } from "@prisma/client-runtime-utils";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const toNumber = (v: Decimal | number): number =>
  typeof v === "number" ? v : Number(v.toString());

/**
 * Shapes an Employee record for API responses.
 * Attaches user name/email from a manual lookup since Employee has no direct FK relation
 * to User in the Prisma schema (we only store userId).
 */
const formatEmployee = (
  emp: {
    id: number;
    userId: number;
    position: string;
    salaryType: string;
    baseSalary: Decimal;
    branchId: number;
    isActive: boolean;
    createdAt: Date;
  },
  user: { id: number; name: string; email: string; role: string } | null,
  branch: { id: number; name: string } | null,
) => ({
  id: emp.id,
  userId: emp.userId,
  userName: user?.name ?? "Sin nombre",
  userEmail: user?.email ?? "",
  position: emp.position,
  salaryType: emp.salaryType,
  baseSalary: toNumber(emp.baseSalary),
  branchId: emp.branchId,
  branchName: branch?.name ?? "Sucursal desconocida",
  isActive: emp.isActive,
});

const formatRecord = (
  record: {
    id: number;
    employeeId: number;
    period: string;
    baseSalary: Decimal;
    advances: Decimal;
    bonuses: Decimal;
    deductions: Decimal;
    netPay: Decimal;
    status: string;
    paidAt: Date | null;
    observations: string | null;
    createdAt: Date;
    employee: {
      id: number;
      userId: number;
      position: string;
      salaryType: string;
      baseSalary: Decimal;
      branchId: number;
      isActive: boolean;
      createdAt: Date;
    };
  },
  user: { id: number; name: string; email: string; role: string } | null,
  branch: { id: number; name: string } | null,
) => ({
  id: record.id,
  employeeId: record.employeeId,
  period: record.period,
  baseSalary: toNumber(record.baseSalary),
  advances: toNumber(record.advances),
  bonuses: toNumber(record.bonuses),
  deductions: toNumber(record.deductions),
  netPay: toNumber(record.netPay),
  status: record.status,
  paidAt: record.paidAt?.toISOString() ?? null,
  observations: record.observations,
  createdAt: record.createdAt.toISOString(),
  employee: formatEmployee(record.employee, user, branch),
});

// ─── Controllers ──────────────────────────────────────────────────────────────

/**
 * GET /payroll/employees
 * Returns active employees. ADMIN sees all branches; others see only their own.
 */
export const getEmployees = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autorizado." });

    const employees = await prisma.employee.findMany({
      where: {
        isActive: true,
        ...(authUser.role !== "ADMIN" && {
          branchId: { in: authUser.branchIds },
        }),
      },
      orderBy: { createdAt: "asc" },
    });

    if (employees.length === 0) {
      return res.status(200).json([]);
    }

    // Batch-fetch related users and branches
    const userIds = [...new Set(employees.map((e) => e.userId))];
    const branchIds = [...new Set(employees.map((e) => e.branchId))];

    const [users, branches] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true, role: true },
      }),
      prisma.branch.findMany({
        where: { id: { in: branchIds } },
        select: { id: true, name: true },
      }),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    const branchMap = new Map(branches.map((b) => [b.id, b]));

    const formatted = employees.map((emp) =>
      formatEmployee(emp, userMap.get(emp.userId) ?? null, branchMap.get(emp.branchId) ?? null),
    );

    return res.status(200).json(formatted);
  } catch {
    return res.status(500).json({ error: "Error al obtener empleados." });
  }
};

/**
 * POST /payroll/employees
 * Registers an existing system user as a payroll employee.
 *
 * @body userId      - ID of an existing User record
 * @body position    - Job title
 * @body salaryType  - FIXED | HOURLY | COMMISSION
 * @body baseSalary  - Monthly base salary amount
 * @body branchId    - Branch where the employee works
 */
export const createEmployee = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autorizado." });

    const { userId, position, salaryType, baseSalary, branchId } = req.body;

    if (!userId || !position || !baseSalary || !branchId) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }

    // Verify user exists
    const user = await prisma.user.findUnique({ where: { id: Number(userId) } });
    if (!user) {
      return res.status(404).json({ error: "El usuario especificado no existe." });
    }

    // Verify branch exists
    const branch = await prisma.branch.findUnique({ where: { id: Number(branchId) } });
    if (!branch) {
      return res.status(404).json({ error: "La sucursal especificada no existe." });
    }

    // Check if already registered (upsert to allow re-activation)
    const existing = await prisma.employee.findUnique({ where: { userId: Number(userId) } });

    let employee;
    if (existing) {
      employee = await prisma.employee.update({
        where: { userId: Number(userId) },
        data: {
          position: String(position),
          salaryType: String(salaryType ?? "FIXED"),
          baseSalary: Number(baseSalary),
          branchId: Number(branchId),
          isActive: true,
        },
      });
    } else {
      employee = await prisma.employee.create({
        data: {
          userId: Number(userId),
          position: String(position),
          salaryType: String(salaryType ?? "FIXED"),
          baseSalary: Number(baseSalary),
          branchId: Number(branchId),
        },
      });
    }

    return res.status(201).json({
      message: "Empleado registrado correctamente.",
      data: formatEmployee(employee, user, branch),
    });
  } catch (error) {
    if (error instanceof Error) {
      return res.status(400).json({ error: error.message });
    }
    return res.status(500).json({ error: "Error al crear el empleado." });
  }
};

/**
 * GET /payroll/records?period=YYYY-MM
 * Returns payroll records for a given period.
 * ADMIN sees all; others see only their branch.
 */
export const getRecords = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autorizado." });

    const period = String(req.query.period ?? "");
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ error: "El período debe tener formato YYYY-MM." });
    }

    const records = await prisma.payrollRecord.findMany({
      where: {
        period,
        ...(authUser.role !== "ADMIN" && {
          employee: { branchId: { in: authUser.branchIds } },
        }),
      },
      include: { employee: true },
      orderBy: { createdAt: "desc" },
    });

    if (records.length === 0) {
      return res.status(200).json([]);
    }

    const userIds = [...new Set(records.map((r) => r.employee.userId))];
    const branchIds = [...new Set(records.map((r) => r.employee.branchId))];

    const [users, branches] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true, role: true },
      }),
      prisma.branch.findMany({
        where: { id: { in: branchIds } },
        select: { id: true, name: true },
      }),
    ]);

    const userMap = new Map(users.map((u) => [u.id, u]));
    const branchMap = new Map(branches.map((b) => [b.id, b]));

    const formatted = records.map((r) =>
      formatRecord(
        r,
        userMap.get(r.employee.userId) ?? null,
        branchMap.get(r.employee.branchId) ?? null,
      ),
    );

    return res.status(200).json(formatted);
  } catch {
    return res.status(500).json({ error: "Error al obtener las liquidaciones." });
  }
};

/**
 * POST /payroll/records
 * Creates a new payroll record for an employee in a given period.
 *
 * @body employeeId   - ID of the Employee record
 * @body period       - "YYYY-MM"
 * @body advances     - Optional: advance payments to discount
 * @body bonuses      - Optional: bonuses to add
 * @body deductions   - Optional: other deductions
 * @body observations - Optional: notes
 */
export const createRecord = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autorizado." });

    const { employeeId, period, advances = 0, bonuses = 0, deductions = 0, observations } = req.body;

    if (!employeeId || !period) {
      return res.status(400).json({ error: "Faltan campos obligatorios." });
    }
    if (!/^\d{4}-\d{2}$/.test(String(period))) {
      return res.status(400).json({ error: "El período debe tener formato YYYY-MM." });
    }

    const employee = await prisma.employee.findUnique({
      where: { id: Number(employeeId) },
    });
    if (!employee) {
      return res.status(404).json({ error: "Empleado no encontrado." });
    }

    const baseSalary = Number(employee.baseSalary);
    const netPay = baseSalary + Number(bonuses) - Number(advances) - Number(deductions);

    const record = await prisma.payrollRecord.create({
      data: {
        employeeId: Number(employeeId),
        period: String(period),
        baseSalary,
        advances: Number(advances),
        bonuses: Number(bonuses),
        deductions: Number(deductions),
        netPay,
        observations: observations ? String(observations) : null,
      },
      include: { employee: true },
    });

    const [user, branch] = await Promise.all([
      prisma.user.findUnique({
        where: { id: record.employee.userId },
        select: { id: true, name: true, email: true, role: true },
      }),
      prisma.branch.findUnique({
        where: { id: record.employee.branchId },
        select: { id: true, name: true },
      }),
    ]);

    return res.status(201).json({
      message: "Liquidación creada correctamente.",
      data: formatRecord(record, user, branch),
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("Unique constraint")) {
      return res.status(409).json({
        error: "Ya existe una liquidación para este empleado en el período indicado.",
      });
    }
    return res.status(500).json({ error: "Error al crear la liquidación." });
  }
};

/**
 * PATCH /payroll/records/:id/pay
 * Marks a payroll record as PAID and sets paidAt to now.
 */
export const markAsPaid = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autorizado." });

    const recordId = Number(req.params.id);
    if (isNaN(recordId)) {
      return res.status(400).json({ error: "ID de liquidación inválido." });
    }

    const existing = await prisma.payrollRecord.findUnique({
      where: { id: recordId },
    });
    if (!existing) {
      return res.status(404).json({ error: "Liquidación no encontrada." });
    }
    if (existing.status === "PAID") {
      return res.status(409).json({ error: "Esta liquidación ya fue pagada." });
    }

    const updated = await prisma.payrollRecord.update({
      where: { id: recordId },
      data: { status: "PAID", paidAt: new Date() },
      include: { employee: true },
    });

    const [user, branch] = await Promise.all([
      prisma.user.findUnique({
        where: { id: updated.employee.userId },
        select: { id: true, name: true, email: true, role: true },
      }),
      prisma.branch.findUnique({
        where: { id: updated.employee.branchId },
        select: { id: true, name: true },
      }),
    ]);

    return res.status(200).json({
      message: "Liquidación marcada como pagada.",
      data: formatRecord(updated, user, branch),
    });
  } catch {
    return res.status(500).json({ error: "Error al actualizar la liquidación." });
  }
};

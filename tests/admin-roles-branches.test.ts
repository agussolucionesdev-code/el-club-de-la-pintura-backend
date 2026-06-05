import request from "supertest";
import bcrypt from "bcrypt";
import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";

describe("Administracion segura de roles y sucursales", () => {
  const runId = Date.now();
  const adminCreds = {
    email: `robot_admin_roles_${runId}@elclub.com`,
    password: "supersecretpassword",
  };
  const managerEmail = `robot_manager_roles_${runId}@elclub.com`;
  const employeeEmail = `robot_employee_roles_${runId}@elclub.com`;

  let adminToken = "";
  let adminId = 0;
  let managerId = 0;
  let employeeId = 0;
  let assignedBranchId = 0;
  let emptyBranchId = 0;

  beforeAll(async () => {
    const [assignedBranch, emptyBranch] = await Promise.all([
      prisma.branch.create({
        data: { name: `Admin Sucursal Asignada ${runId}`, location: "A" },
      }),
      prisma.branch.create({
        data: { name: `Admin Sucursal Vacia ${runId}`, location: "B" },
      }),
    ]);
    assignedBranchId = assignedBranch.id;
    emptyBranchId = emptyBranch.id;

    const password = await bcrypt.hash(adminCreds.password, 10);
    const [admin, manager, employee] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Robot Admin Roles ${runId}`,
          email: adminCreds.email,
          password,
          role: "ADMIN",
          branches: { connect: [{ id: assignedBranchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Robot Manager Roles ${runId}`,
          email: managerEmail,
          password,
          role: "ENCARGADO",
          branches: { connect: [{ id: assignedBranchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Robot Employee Roles ${runId}`,
          email: employeeEmail,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: assignedBranchId }] },
        },
      }),
    ]);

    adminId = admin.id;
    managerId = manager.id;
    employeeId = employee.id;

    adminToken = generateTestToken({ userId: adminId, role: "ADMIN", branchIds: [assignedBranchId] });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({
      where: { actorUserId: adminId },
    });
    await prisma.user.deleteMany({
      where: {
        email: { in: [adminCreds.email, managerEmail, employeeEmail] },
      },
    });
    await prisma.branch.deleteMany({
      where: { id: { in: [assignedBranchId, emptyBranchId] } },
    });
    await prisma.$disconnect();
  });

  it("expone catalogo de roles y marca ADMIN como inmutable", async () => {
    const response = await request(app)
      .get("/api/users/roles")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.roles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "ADMIN",
          immutable: true,
          canDeleteUsers: false,
        }),
        expect.objectContaining({ key: "ENCARGADO", canDeleteUsers: true }),
        expect.objectContaining({ key: "EMPLOYEE", canDeleteUsers: true }),
      ]),
    );
  });

  it("impide eliminar o limpiar el rol ADMIN", async () => {
    const deleteAdminUserResponse = await request(app)
      .delete(`/api/users/${adminId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(deleteAdminUserResponse.status).toBe(400);

    const cleanAdminRoleResponse = await request(app)
      .delete("/api/users/roles/ADMIN/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmationPhrase: "ELIMINAR ROL ADMIN" });

    expect(cleanAdminRoleResponse.status).toBe(409);
    expect(cleanAdminRoleResponse.body.error).toContain("ADMIN");
  });

  it("bloquea democion del admin que sostiene el acceso maestro", async () => {
    const response = await request(app)
      .put(`/api/users/${adminId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: `Robot Admin Roles ${runId}`,
        email: adminCreds.email,
        role: "EMPLOYEE",
        branchIds: [assignedBranchId],
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("ADMIN");
  });

  it("exige confirmacion para limpiar usuarios de un rol operativo", async () => {
    const missingConfirmationResponse = await request(app)
      .delete("/api/users/roles/EMPLOYEE/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(missingConfirmationResponse.status).toBe(400);

    const response = await request(app)
      .delete("/api/users/roles/EMPLOYEE/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ confirmationPhrase: "ELIMINAR ROL EMPLOYEE" });

    expect(response.status).toBe(200);
    expect(response.body.deletedCount).toBeGreaterThanOrEqual(1);

    const deletedEmployee = await prisma.user.findUnique({
      where: { id: employeeId },
    });
    expect(deletedEmployee).toBeNull();
  });

  it("permite eliminar una sucursal vacia y bloquea sucursales con usuarios", async () => {
    const deleteEmptyResponse = await request(app)
      .delete(`/api/branches/${emptyBranchId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(deleteEmptyResponse.status).toBe(200);
    emptyBranchId = 0;

    const deleteAssignedResponse = await request(app)
      .delete(`/api/branches/${assignedBranchId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(deleteAssignedResponse.status).toBe(409);
    expect(deleteAssignedResponse.body.data.blockers.users).toBeGreaterThan(0);
  });

  it("exige confirmacion para eliminacion masiva de sucursales", async () => {
    const response = await request(app)
      .delete("/api/branches")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Confirmacion requerida");
    expect(managerId).toBeGreaterThan(0);
  });

  it("registra y expone auditoria administrativa filtrable", async () => {
    const response = await request(app)
      .get("/api/audit-logs?action=branch.deleted&entityType=Branch&limit=10")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actorUserId: adminId,
          action: "branch.deleted",
          entityType: "Branch",
          actor: expect.objectContaining({
            id: adminId,
            role: "ADMIN",
          }),
        }),
      ]),
    );
  });
});

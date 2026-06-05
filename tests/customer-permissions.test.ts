import request from "supertest";
import bcrypt from "bcrypt";
import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";

describe("Permisos operativos de clientes", () => {
  const runId = Date.now();
  const employeeCreds = {
    email: `robot_customer_employee_${runId}@elclub.com`,
    password: "supersecretpassword",
  };
  const managerCreds = {
    email: `robot_customer_manager_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let employeeToken = "";
  let managerToken = "";
  let managerId = 0;
  let branchId = 0;
  let customerId = 0;

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: {
        name: `Clientes Test ${runId}`,
        location: "Mostrador",
      },
    });
    branchId = branch.id;

    const password = await bcrypt.hash(employeeCreds.password, 10);
    const [employee, manager] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Robot Cliente Empleado ${runId}`,
          email: employeeCreds.email,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Robot Cliente Encargado ${runId}`,
          email: managerCreds.email,
          password,
          role: "ENCARGADO",
          branches: { connect: [{ id: branchId }] },
        },
      }),
    ]);
    managerId = manager.id;

    employeeToken = generateTestToken({ userId: employee.id, role: "EMPLOYEE", branchIds: [branchId] });
    managerToken = generateTestToken({ userId: managerId, role: "ENCARGADO", branchIds: [branchId] });
  });

  afterAll(async () => {
    await prisma.auditLog.deleteMany({ where: { actorUserId: managerId } });
    if (customerId) {
      await prisma.customer.deleteMany({ where: { id: customerId } });
    }
    await prisma.user.deleteMany({
      where: { email: { in: [employeeCreds.email, managerCreds.email] } },
    });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  it("permite alta de cliente al empleado pero bloquea edicion y baja", async () => {
    const createResponse = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${employeeToken}`)
      .send({
        name: `Cliente Mostrador ${runId}`,
        document: `DNI-${runId}`,
        type: "CONSUMER",
        phone: "1111111111",
      });

    expect(createResponse.status).toBe(201);
    customerId = createResponse.body.data.id;

    const updateResponse = await request(app)
      .put(`/api/customers/${customerId}`)
      .set("Authorization", `Bearer ${employeeToken}`)
      .send({ name: `Cliente Editado ${runId}` });

    expect(updateResponse.status).toBe(403);

    const deleteResponse = await request(app)
      .delete(`/api/customers/${customerId}`)
      .set("Authorization", `Bearer ${employeeToken}`);

    expect(deleteResponse.status).toBe(403);
  });

  it("permite al encargado actualizar y archivar clientes con auditoria", async () => {
    const updateResponse = await request(app)
      .put(`/api/customers/${customerId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ name: `Cliente Gestionado ${runId}` });

    expect(updateResponse.status).toBe(200);

    const deleteResponse = await request(app)
      .delete(`/api/customers/${customerId}`)
      .set("Authorization", `Bearer ${managerToken}`);

    expect(deleteResponse.status).toBe(200);

    const auditLog = await prisma.auditLog.findFirst({
      where: {
        actorUserId: managerId,
        entityType: "Customer",
        entityId: String(customerId),
        action: "customer.archived",
      },
    });
    expect(auditLog).toBeTruthy();
  });
});

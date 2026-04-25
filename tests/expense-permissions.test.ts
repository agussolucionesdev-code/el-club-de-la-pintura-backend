import request from "supertest";
import bcrypt from "bcrypt";
import app from "../src/app";
import prisma from "../src/config/db";

describe("Permisos de egresos de caja", () => {
  const runId = Date.now();
  const employeeCreds = {
    email: `robot_expense_employee_${runId}@elclub.com`,
    password: "supersecretpassword",
  };
  const managerCreds = {
    email: `robot_expense_manager_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let employeeToken = "";
  let managerToken = "";
  let branchId = 0;
  let managerId = 0;
  let cashRegisterId = 0;
  let expenseId = 0;

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: { name: `Egresos Test ${runId}`, location: "Caja" },
    });
    branchId = branch.id;

    const password = await bcrypt.hash(employeeCreds.password, 10);
    const [, manager] = await Promise.all([
      prisma.user.create({
        data: {
          name: `Robot Egreso Empleado ${runId}`,
          email: employeeCreds.email,
          password,
          role: "EMPLOYEE",
          branches: { connect: [{ id: branchId }] },
        },
      }),
      prisma.user.create({
        data: {
          name: `Robot Egreso Encargado ${runId}`,
          email: managerCreds.email,
          password,
          role: "ENCARGADO",
          branches: { connect: [{ id: branchId }] },
        },
      }),
    ]);
    managerId = manager.id;

    const cashRegister = await prisma.cashRegister.create({
      data: {
        initialBalance: 10000,
        expectedBalance: 10000,
        branchId,
        userId: managerId,
        status: "OPEN",
      },
    });
    cashRegisterId = cashRegister.id;

    const employeeLogin = await request(app)
      .post("/api/users/login")
      .send(employeeCreds);
    const managerLogin = await request(app)
      .post("/api/users/login")
      .send(managerCreds);
    employeeToken = employeeLogin.body.token;
    managerToken = managerLogin.body.token;
  });

  afterAll(async () => {
    await prisma.internalReceipt.deleteMany({ where: { cashRegisterId } });
    if (expenseId) await prisma.expense.deleteMany({ where: { id: expenseId } });
    await prisma.cashRegister.deleteMany({ where: { id: cashRegisterId } });
    await prisma.user.deleteMany({
      where: { email: { in: [employeeCreds.email, managerCreds.email] } },
    });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  it("bloquea egresos para empleados y permite al encargado registrar caja", async () => {
    const payload = {
      amount: 1200,
      reason: "Compra menor de mostrador",
      category: "INSUMOS",
      type: "VARIABLE",
      branchId,
      cashRegisterId,
    };

    const employeeResponse = await request(app)
      .post("/api/expenses")
      .set("Authorization", `Bearer ${employeeToken}`)
      .send(payload);

    expect(employeeResponse.status).toBe(403);

    const managerResponse = await request(app)
      .post("/api/expenses")
      .set("Authorization", `Bearer ${managerToken}`)
      .send(payload);

    expect(managerResponse.status).toBe(201);
    expenseId = managerResponse.body.data.id;
    expect(managerResponse.body.receipt.receiptType).toBe("EXPENSE");
  });
});

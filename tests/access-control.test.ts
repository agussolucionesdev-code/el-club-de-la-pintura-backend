import request from "supertest";
import bcrypt from "bcrypt";
import app from "../src/app";
import prisma from "../src/config/db";

describe("Controles de acceso por rol y sucursal", () => {
  const employeeCreds = {
    email: "robot_employee_acl@elclub.com",
    password: "supersecretpassword",
  };

  const branchAName = "Sucursal ACL Norte";
  const branchBName = "Sucursal ACL Sur";

  let employeeToken = "";
  let branchAId = 0;
  let branchBId = 0;

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: employeeCreds.email } });
    await prisma.branch.deleteMany({
      where: { name: { in: [branchAName, branchBName] } },
    });

    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({ data: { name: branchAName, location: "Zona A" } }),
      prisma.branch.create({ data: { name: branchBName, location: "Zona B" } }),
    ]);

    branchAId = branchA.id;
    branchBId = branchB.id;

    const hashedPassword = await bcrypt.hash(employeeCreds.password, 10);

    await prisma.user.create({
      data: {
        name: "Robot Employee ACL",
        email: employeeCreds.email,
        password: hashedPassword,
        role: "EMPLOYEE",
        branches: {
          connect: [{ id: branchAId }],
        },
      },
    });

    const loginResponse = await request(app)
      .post("/api/users/login")
      .send(employeeCreds);

    employeeToken = loginResponse.body.token;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: employeeCreds.email } });
    await prisma.branch.deleteMany({
      where: { id: { in: [branchAId, branchBId] } },
    });
    await prisma.$disconnect();
  });

  it("rechaza apertura de caja sin token", async () => {
    const response = await request(app).post("/api/cash-registers/open").send({
      branchId: branchAId,
      initialBalance: 1000,
    });

    expect(response.status).toBe(401);
  });

  it("bloquea a un empleado del directorio de usuarios", async () => {
    const response = await request(app)
      .get("/api/users")
      .set("Authorization", `Bearer ${employeeToken}`);

    expect(response.status).toBe(403);
  });

  it("bloquea a un empleado de otra sucursal", async () => {
    const response = await request(app)
      .get(`/api/stock/${branchBId}`)
      .set("Authorization", `Bearer ${employeeToken}`);

    expect(response.status).toBe(403);
  });
});

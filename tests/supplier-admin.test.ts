import request from "supertest";
import bcrypt from "bcrypt";
import app from "../src/app";
import prisma from "../src/config/db";

describe("Gestion segura de proveedores", () => {
  const runId = Date.now();
  const adminCreds = {
    email: `robot_admin_suppliers_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let adminToken = "";
  let adminId = 0;
  let branchId = 0;
  let supplierId = 0;
  let linkedSupplierId = 0;
  let linkedProductId = 0;

  beforeAll(async () => {
    const branch = await prisma.branch.create({
      data: {
        name: `Supplier Test Branch ${runId}`,
        location: "Laboratorio",
      },
    });
    branchId = branch.id;

    const password = await bcrypt.hash(adminCreds.password, 10);
    const admin = await prisma.user.create({
      data: {
        name: `Robot Admin Suppliers ${runId}`,
        email: adminCreds.email,
        password,
        role: "ADMIN",
        branches: { connect: [{ id: branchId }] },
      },
    });
    adminId = admin.id;

    const loginResponse = await request(app)
      .post("/api/users/login")
      .send(adminCreds);
    adminToken = loginResponse.body.token;
  });

  afterAll(async () => {
    if (linkedProductId) {
      await prisma.product.deleteMany({ where: { id: linkedProductId } });
    }
    await prisma.auditLog.deleteMany({
      where: { actorUserId: adminId },
    });
    await prisma.supplier.deleteMany({
      where: { id: { in: [supplierId, linkedSupplierId].filter(Boolean) } },
    });
    await prisma.user.deleteMany({ where: { id: adminId } });
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await prisma.$disconnect();
  });

  it("lista proveedores con contrato data/meta y registra auditoria de alta", async () => {
    const createResponse = await request(app)
      .post("/api/suppliers")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        companyName: `Proveedor Seguro ${runId}`,
        cuit: `30${String(runId).slice(-8)}1`,
        contactName: "Compras",
        phone: "11 5555-5555",
        email: `proveedor_${runId}@elclub.com`,
      });

    expect(createResponse.status).toBe(201);
    supplierId = createResponse.body.supplier.id;

    const listResponse = await request(app)
      .get("/api/suppliers?limit=10")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(listResponse.status).toBe(200);
    expect(Array.isArray(listResponse.body.data)).toBe(true);
    expect(listResponse.body.meta).toEqual(
      expect.objectContaining({ limit: 10 }),
    );

    const auditLog = await prisma.auditLog.findFirst({
      where: {
        actorUserId: adminId,
        action: "supplier.created",
        entityType: "Supplier",
        entityId: String(supplierId),
      },
    });
    expect(auditLog).toBeTruthy();
  });

  it("actualiza proveedor validando duplicados y auditando el cambio", async () => {
    const response = await request(app)
      .put(`/api/suppliers/${supplierId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        companyName: `Proveedor Seguro Actualizado ${runId}`,
        phone: "11 6666-6666",
      });

    expect(response.status).toBe(200);
    expect(response.body.supplier.companyName).toContain("Actualizado");

    const auditLog = await prisma.auditLog.findFirst({
      where: {
        actorUserId: adminId,
        action: "supplier.updated",
        entityId: String(supplierId),
      },
    });
    expect(auditLog).toBeTruthy();
  });

  it("bloquea la baja de proveedores con productos activos asociados", async () => {
    const supplier = await prisma.supplier.create({
      data: {
        companyName: `Proveedor Con Producto ${runId}`,
        phone: "1122223333",
      },
    });
    linkedSupplierId = supplier.id;

    const product = await prisma.product.create({
      data: {
        sku: `SUP-${runId}`,
        name: `Producto proveedor ${runId}`,
        brand: "Marca Test",
        category: "Pinturas",
        supplierId: linkedSupplierId,
        costPrice: 1000,
        retailPrice: 1500,
      },
    });
    linkedProductId = product.id;

    const response = await request(app)
      .delete(`/api/suppliers/${linkedSupplierId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(response.status).toBe(409);
    expect(response.body.data.blockers.activeProducts).toBe(1);
  });
});

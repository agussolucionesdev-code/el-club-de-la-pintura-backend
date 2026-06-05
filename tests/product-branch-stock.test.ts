import request from "supertest";
import bcrypt from "bcrypt";
import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";

describe("Catalogo multi-sucursal sin stock hardcodeado", () => {
  const runId = Date.now();
  const managerCreds = {
    email: `robot_catalog_${runId}@elclub.com`,
    password: "supersecretpassword",
  };
  const adminCreds = {
    email: `robot_catalog_admin_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let managerToken = "";
  let adminToken = "";
  let branchAId = 0;
  let branchBId = 0;
  let productId = 0;
  let supplierId = 0;
  const importedSupplierName = `Marca Importada Sin Datos Falsos ${runId}`;
  const importedSku = `IMP-${runId}`;

  beforeAll(async () => {
    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({
        data: { name: `Catalogo Norte ${runId}`, location: "Zona A" },
      }),
      prisma.branch.create({
        data: { name: `Catalogo Sur ${runId}`, location: "Zona B" },
      }),
    ]);

    branchAId = branchA.id;
    branchBId = branchB.id;

    const hashedPassword = await bcrypt.hash(managerCreds.password, 10);
    const hashedAdminPassword = await bcrypt.hash(adminCreds.password, 10);
    const manager = await prisma.user.create({
      data: {
        name: `Robot Catalogo ${runId}`,
        email: managerCreds.email,
        password: hashedPassword,
        role: "ENCARGADO",
        branches: { connect: [{ id: branchBId }] },
      },
    });
    const adminUser = await prisma.user.create({
      data: {
        name: `Robot Catalogo Admin ${runId}`,
        email: adminCreds.email,
        password: hashedAdminPassword,
        role: "ADMIN",
        branches: { connect: [{ id: branchAId }, { id: branchBId }] },
      },
    });

    managerToken = generateTestToken({ userId: manager.id, role: "ENCARGADO", branchIds: [branchBId] });
    adminToken = generateTestToken({ userId: adminUser.id, role: "ADMIN", branchIds: [branchAId, branchBId] });
  });

  afterAll(async () => {
    if (productId) {
      await prisma.auditLog.deleteMany({
        where: { entityType: "Product", entityId: String(productId) },
      });
      await prisma.movement.deleteMany({ where: { productId } });
      await prisma.stock.deleteMany({ where: { productId } });
      await prisma.product.deleteMany({ where: { id: productId } });
    }
    if (supplierId) {
      await prisma.supplier.deleteMany({ where: { id: supplierId } });
    }
    await prisma.product.deleteMany({ where: { sku: importedSku } });
    await prisma.supplier.deleteMany({
      where: { companyName: importedSupplierName },
    });
    await prisma.user.deleteMany({ where: { email: managerCreds.email } });
    await prisma.user.deleteMany({ where: { email: adminCreds.email } });
    await prisma.branch.deleteMany({
      where: { id: { in: [branchAId, branchBId] } },
    });
    await prisma.$disconnect();
  });

  it("crea stock inicial solo en la sucursal activa indicada", async () => {
    const response = await request(app)
      .post("/api/products")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        sku: `CAT-${runId}`,
        name: `Producto Catalogo ${runId}`,
        brand: "Robot",
        category: "Pinturas",
        costPrice: 100,
        retailPrice: 180,
        stock: 7,
        stockBranchId: branchBId,
      });

    expect(response.status).toBe(201);
    productId = response.body.id;

    const [stockA, stockB] = await Promise.all([
      prisma.stock.findUnique({
        where: { productId_branchId: { productId, branchId: branchAId } },
      }),
      prisma.stock.findUnique({
        where: { productId_branchId: { productId, branchId: branchBId } },
      }),
    ]);

    expect(stockA).toBeNull();
    expect(stockB?.quantity).toBe(7);
  });

  it("actualiza stock por sucursal explicita y bloquea sucursales no asignadas", async () => {
    const updateResponse = await request(app)
      .put(`/api/products/${productId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        costPrice: 110,
        profitMargin: 35,
        ivaPercentage: 21,
        stock: 11,
        stockBranchId: branchBId,
      });

    expect(updateResponse.status).toBe(200);

    const stockB = await prisma.stock.findUnique({
      where: { productId_branchId: { productId, branchId: branchBId } },
    });
    expect(stockB?.quantity).toBe(11);

    const forbiddenResponse = await request(app)
      .put(`/api/products/${productId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        stock: 3,
        stockBranchId: branchAId,
      });

    expect(forbiddenResponse.status).toBe(400);
    expect(forbiddenResponse.body.error).toContain("No tienes permisos");
  });

  it("permite actualizaciones parciales sin limpiar datos comerciales", async () => {
    const supplier = await prisma.supplier.create({
      data: {
        companyName: `Proveedor Parcial ${runId}`,
        contactName: "Robot",
        phone: "Sin especificar",
        address: "Test",
      },
    });
    supplierId = supplier.id;

    await prisma.product.update({
      where: { id: productId },
      data: {
        barcode: `INT-${runId}`,
        wholesalePrice: 150,
        supplierId,
      },
    });

    const response = await request(app)
      .put(`/api/products/${productId}`)
      .set("Authorization", `Bearer ${managerToken}`)
      .send({ images: [`https://cdn.example.com/${runId}.jpg`] });

    expect(response.status).toBe(200);

    const product = await prisma.product.findUnique({
      where: { id: productId },
    });
    expect(product?.barcode).toBe(`INT-${runId}`);
    expect(product?.wholesalePrice).toBe(150);
    expect(product?.supplierId).toBe(supplierId);
    expect(product?.images).toEqual([`https://cdn.example.com/${runId}.jpg`]);
  });

  it("bloquea el archivado masivo sin confirmacion de servidor", async () => {
    const response = await request(app)
      .delete("/api/products/delete-all")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Confirmacion requerida");

    const product = await prisma.product.findUnique({
      where: { id: productId },
    });
    expect(product?.isActive).toBe(true);
  });

  it("importa lista creando proveedores sin CUIT ni email ficticios", async () => {
    const response = await request(app)
      .post("/api/products/import")
      .set("Authorization", `Bearer ${managerToken}`)
      .send({
        supplierName: importedSupplierName,
        globalMargin: 30,
        globalIva: 21,
        products: [
          {
            sku: importedSku,
            name: `Latex importado ${runId}`,
            costPrice: 1234,
            stock: 0,
          },
        ],
      });

    expect(response.status).toBe(201);

    const supplier = await prisma.supplier.findFirst({
      where: { companyName: importedSupplierName },
    });

    expect(supplier).toEqual(
      expect.objectContaining({
        cuit: null,
        email: null,
        contactName: "Importacion de lista",
      }),
    );
  });
});

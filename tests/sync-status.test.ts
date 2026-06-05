import request from "supertest";
import bcrypt from "bcrypt";
import app from "../src/app";
import prisma from "../src/config/db";
import { generateTestToken } from "./helpers/auth";

describe("Motor offline ERP: checkpoints y estado de sincronizacion", () => {
  const runId = Date.now();
  const deviceId = `device-sync-${runId}`;
  const operatorCreds = {
    email: `robot_sync_${runId}@elclub.com`,
    password: "supersecretpassword",
  };
  const offlineCustomerDocument = `SYNC-CUST-${runId}`;

  let operatorToken = "";
  let operatorId = 0;
  let branchAId = 0;
  let branchBId = 0;
  let syncedCustomerId = 0;

  beforeAll(async () => {
    const [branchA, branchB] = await Promise.all([
      prisma.branch.create({
        data: { name: `Sucursal Sync Norte ${runId}`, location: "Zona Sync A" },
      }),
      prisma.branch.create({
        data: { name: `Sucursal Sync Sur ${runId}`, location: "Zona Sync B" },
      }),
    ]);

    branchAId = branchA.id;
    branchBId = branchB.id;

    const hashedPassword = await bcrypt.hash(operatorCreds.password, 10);
    const operator = await prisma.user.create({
      data: {
        name: `Robot Sync ${runId}`,
        email: operatorCreds.email,
        password: hashedPassword,
        role: "ENCARGADO",
        branches: { connect: [{ id: branchAId }] },
      },
    });
    operatorId = operator.id;

    await prisma.syncOperation.createMany({
      data: [
        {
          idempotencyKey: `sync-accepted-${runId}`,
          branchId: branchAId,
          userId: operatorId,
          type: "POST /sales",
          status: "ACCEPTED",
          payload: { branchId: branchAId },
          processedAt: new Date(),
        },
        {
          idempotencyKey: `sync-rejected-${runId}`,
          branchId: branchAId,
          userId: operatorId,
          type: "PUT /stock/update",
          status: "REJECTED",
          payload: { branchId: branchAId },
          error: "Conflicto de stock de prueba",
          processedAt: new Date(),
        },
        {
          idempotencyKey: `sync-hidden-${runId}`,
          branchId: branchBId,
          userId: operatorId,
          type: "POST /expenses",
          status: "ACCEPTED",
          payload: { branchId: branchBId },
          processedAt: new Date(),
        },
      ],
    });

    operatorToken = generateTestToken({ userId: operatorId, role: "ENCARGADO", branchIds: [branchAId] });
  });

  afterAll(async () => {
    if (syncedCustomerId) {
      await prisma.auditLog.deleteMany({
        where: {
          entityType: "Customer",
          entityId: String(syncedCustomerId),
        },
      });
    }
    await prisma.customer.deleteMany({
      where: { document: offlineCustomerDocument },
    });
    await prisma.syncCheckpoint.deleteMany({
      where: { userId: operatorId },
    });
    await prisma.syncOperation.deleteMany({
      where: { userId: operatorId },
    });
    await prisma.user.deleteMany({ where: { email: operatorCreds.email } });
    await prisma.branch.deleteMany({
      where: { id: { in: [branchAId, branchBId] } },
    });
    await prisma.$disconnect();
  });

  it("persiste checkpoints por dispositivo y devuelve contadores reales por sucursal", async () => {
    const pullResponse = await request(app)
      .get(`/api/sync/pull?branchId=${branchAId}&deviceId=${deviceId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .set("X-Sync-Device-Id", deviceId);

    expect(pullResponse.status).toBe(200);
    expect(pullResponse.body.scope).toMatchObject({
      branchId: branchAId,
      deviceId,
    });
    expect(pullResponse.body.syncCheckpoint).toMatchObject({
      deviceId,
      branchId: branchAId,
      userId: operatorId,
    });
    expect(pullResponse.body.syncCheckpoint.lastPulledAt).toBeTruthy();

    const statusResponse = await request(app)
      .get(`/api/sync/status?branchId=${branchAId}&limit=10&deviceId=${deviceId}`)
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(statusResponse.status).toBe(200);
    expect(statusResponse.body.counters).toMatchObject({
      accepted: 1,
      rejected: 1,
      processing: 0,
      pending: 0,
      total: 2,
    });
    expect(statusResponse.body.operations).toHaveLength(2);
    expect(
      statusResponse.body.operations.every(
        (operation: { branchId: number }) => operation.branchId === branchAId,
      ),
    ).toBe(true);
    expect(statusResponse.body.checkpoints[0]).toMatchObject({
      deviceId,
      branchId: branchAId,
      userId: operatorId,
    });
  });

  it("bloquea consultas de sync hacia sucursales no asignadas", async () => {
    const statusResponse = await request(app)
      .get(`/api/sync/status?branchId=${branchBId}`)
      .set("Authorization", `Bearer ${operatorToken}`);

    expect(statusResponse.status).toBe(400);
    expect(statusResponse.body.error).toContain("No tienes acceso");
  });

  it("sincroniza altas de clientes offline una sola vez y deja auditoria", async () => {
    const operationId = `offline-customer-${runId}`;
    const operationPayload = {
      id: operationId,
      idempotencyKey: operationId,
      type: "CUSTOMER_CREATE",
      endpoint: "/customers",
      method: "POST",
      branchId: branchAId,
      payload: {
        branchId: branchAId,
        name: `Cliente Offline ${runId}`,
        document: offlineCustomerDocument,
        type: "CONSUMER",
        phone: "11 5555-5555",
        email: `offline_${runId}@cliente.com`,
        address: "Mostrador",
      },
    };

    const firstPushResponse = await request(app)
      .post("/api/sync/push")
      .set("Authorization", `Bearer ${operatorToken}`)
      .set("X-Sync-Device-Id", deviceId)
      .send({
        branchId: branchAId,
        deviceId,
        operations: [operationPayload],
      });

    expect(firstPushResponse.status).toBe(202);
    expect(firstPushResponse.body.acceptedOperationIds).toContain(operationId);
    expect(firstPushResponse.body.rejectedOperations).toHaveLength(0);

    const syncedCustomer = await prisma.customer.findUnique({
      where: { document: offlineCustomerDocument },
    });
    expect(syncedCustomer).toBeTruthy();
    expect(syncedCustomer).toMatchObject({
      name: `Cliente Offline ${runId}`,
      document: offlineCustomerDocument,
      type: "CONSUMER",
      phone: "11 5555-5555",
      email: `offline_${runId}@cliente.com`,
      address: "Mostrador",
    });
    syncedCustomerId = syncedCustomer?.id || 0;

    const customerAudit = await prisma.auditLog.findFirst({
      where: {
        action: "customer.created",
        entityType: "Customer",
        entityId: String(syncedCustomerId),
        branchId: branchAId,
      },
    });
    expect(customerAudit).toBeTruthy();

    const duplicatePushResponse = await request(app)
      .post("/api/sync/push")
      .set("Authorization", `Bearer ${operatorToken}`)
      .set("X-Sync-Device-Id", deviceId)
      .send({
        branchId: branchAId,
        deviceId,
        operations: [operationPayload],
      });

    expect(duplicatePushResponse.status).toBe(202);
    expect(duplicatePushResponse.body.acceptedOperationIds).toContain(
      operationId,
    );
    expect(duplicatePushResponse.body.rejectedOperations).toHaveLength(0);

    const customerCount = await prisma.customer.count({
      where: { document: offlineCustomerDocument },
    });
    expect(customerCount).toBe(1);
  });
});

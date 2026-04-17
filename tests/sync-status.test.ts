import request from "supertest";
import bcrypt from "bcrypt";
import app from "../src/app";
import prisma from "../src/config/db";

describe("Motor offline ERP: checkpoints y estado de sincronizacion", () => {
  const runId = Date.now();
  const deviceId = `device-sync-${runId}`;
  const operatorCreds = {
    email: `robot_sync_${runId}@elclub.com`,
    password: "supersecretpassword",
  };

  let operatorToken = "";
  let operatorId = 0;
  let branchAId = 0;
  let branchBId = 0;

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

    const loginResponse = await request(app)
      .post("/api/users/login")
      .send(operatorCreds);

    operatorToken = loginResponse.body.token;
  });

  afterAll(async () => {
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
});

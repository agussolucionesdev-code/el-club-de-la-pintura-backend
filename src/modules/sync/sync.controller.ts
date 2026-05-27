/**
 * Sync Controller — offline-first data synchronization layer.
 *
 * Architecture overview:
 *  1. **Push** (`POST /sync/push`): the device sends queued operations (currently
 *     SALE_CREATE, EXPENSE_CREATE) that were stored in IndexedDB while offline.
 *     Each operation is processed idempotently via its `idempotencyKey`. Accepted
 *     operations are applied and deleted; rejected ones are returned to the client.
 *
 *  2. **Pull** (`GET /sync/pull`): the device fetches a full data snapshot for its
 *     active branch (products, customers, stock levels) so it can serve the POS
 *     while offline. A `checkpoint` token can be used for incremental future pulls.
 *
 *  3. **Status** (`GET /sync/status`): returns the list of sync operations for the
 *     device/branch, used by the sync-status UI badge and `/sync` page.
 *
 * Idempotency: duplicate pushes with the same `idempotencyKey` are silently skipped
 * (the operation is already ACCEPTED in the DB).
 *
 * @module sync.controller
 */
import { Response } from "express";
import { logger } from '../../config/logger';
import { Payment, Prisma } from "@prisma/client";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";
import { createInternalReceipt } from "../internal-receipt/internal-receipt.service";

interface IncomingSyncOperation {
  id?: string;
  idempotencyKey?: string;
  type?: string;
  endpoint?: string;
  method?: string;
  branchId?: number;
  payload?: unknown;
}

const SYNC_STATUS_PROCESSING = "PROCESSING";
const SYNC_STATUS_ACCEPTED = "ACCEPTED";
const SYNC_STATUS_REJECTED = "REJECTED";
const DEFAULT_SYNC_DEVICE_ID = "browser-unknown";
const MAX_SYNC_STATUS_LIMIT = 100;

const firstTextValue = (value: unknown) => {
  if (Array.isArray(value)) {
    const firstValue = value.find((item) => String(item || "").trim() !== "");
    return firstValue === undefined ? "" : String(firstValue);
  }

  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }

  return "";
};

const resolveSyncDeviceId = (req: AuthRequest) => {
  const headerDeviceId = firstTextValue(req.headers["x-sync-device-id"]);
  const queryDeviceId = firstTextValue(req.query.deviceId);
  const bodyDeviceId = firstTextValue(
    req.body && typeof req.body === "object"
      ? (req.body as Record<string, unknown>).deviceId
      : undefined,
  );

  const deviceId = (headerDeviceId || queryDeviceId || bodyDeviceId).trim();
  return deviceId ? deviceId.slice(0, 120) : DEFAULT_SYNC_DEVICE_ID;
};

const resolveStatusLimit = (value: unknown) => {
  const limit = Number(firstTextValue(value));
  if (!Number.isInteger(limit) || limit <= 0) return 50;
  return Math.min(limit, MAX_SYNC_STATUS_LIMIT);
};

const getPayload = (operation: IncomingSyncOperation) => {
  if (
    !operation.payload ||
    typeof operation.payload !== "object" ||
    Array.isArray(operation.payload)
  ) {
    throw new Error("La operacion offline no tiene payload valido.");
  }

  return operation.payload as Record<string, unknown>;
};

const toJsonPayload = (value: unknown): Prisma.InputJsonValue => {
  if (value === undefined) return JSON.parse("null") as Prisma.InputJsonValue;
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
};

const resolveOperationBranchId = (operation: IncomingSyncOperation) => {
  const operationBranchId = Number(operation.branchId);
  if (Number.isInteger(operationBranchId) && operationBranchId > 0) {
    return operationBranchId;
  }

  if (
    operation.payload &&
    typeof operation.payload === "object" &&
    !Array.isArray(operation.payload)
  ) {
    const payload = operation.payload as Record<string, unknown>;
    const payloadBranchId = Number(payload.branchId);
    if (Number.isInteger(payloadBranchId) && payloadBranchId > 0) {
      return payloadBranchId;
    }
  }

  return null;
};

const getOperationDescriptor = (operation: IncomingSyncOperation) =>
  operation.type ||
  `${String(operation.method || "").toUpperCase()} ${operation.endpoint || "UNKNOWN"}`.trim();

const ensureBranchAccess = (
  branchId: number,
  authUser: { role: string; branchIds: number[] },
) => {
  if (!Number.isInteger(branchId) || branchId <= 0) {
    throw new Error("La sucursal de la operacion offline no es valida.");
  }

  if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
    throw new Error("La operacion apunta a una sucursal no autorizada.");
  }
};

const resolveBranchWhere = (
  branchId: number,
  authUser: { role: string; branchIds: number[] },
) => {
  if (branchId === 0) {
    return authUser.role === "ADMIN" ? undefined : { in: authUser.branchIds };
  }

  if (authUser.role !== "ADMIN" && !authUser.branchIds.includes(branchId)) {
    throw new Error("No tienes acceso a la sucursal solicitada.");
  }

  return branchId;
};

const checkpointBranchIdFromScope = (branchId: number) =>
  Number.isInteger(branchId) && branchId > 0 ? branchId : null;

const persistSyncCheckpoint = async ({
  deviceId,
  userId,
  branchId,
  lastPulledAt,
  lastPushedAt,
}: {
  deviceId: string;
  userId: number;
  branchId: number | null;
  lastPulledAt?: Date;
  lastPushedAt?: Date;
}) => {
  const data: Prisma.SyncCheckpointUpdateInput = {};
  if (lastPulledAt) data.lastPulledAt = lastPulledAt;
  if (lastPushedAt) data.lastPushedAt = lastPushedAt;

  const existingCheckpoint = await prisma.syncCheckpoint.findFirst({
    where: { deviceId, userId, branchId },
  });

  if (existingCheckpoint) {
    return prisma.syncCheckpoint.update({
      where: { id: existingCheckpoint.id },
      data,
    });
  }

  return prisma.syncCheckpoint.create({
    data: {
      deviceId,
      userId,
      branchId,
      lastPulledAt,
      lastPushedAt,
    },
  });
};

const recordSyncAudit = async (
  action: string,
  authUser: { id: number },
  operationId: string,
  branchId: number | null,
  metadata: Record<string, unknown>,
) => {
  await prisma.auditLog
    .create({
      data: {
        actorUserId: authUser.id,
        branchId,
        action,
        entityType: "SyncOperation",
        entityId: operationId,
        metadata: toJsonPayload(metadata),
      },
    })
    .catch((error: unknown) => {
      logger.warn("No se pudo registrar auditoria de sync:", error);
    });
};

const roundSyncMoney = (value: number) => Math.round(value * 100) / 100;

const normalizeSyncPaymentMethod = (value: unknown) => {
  const method = String(value || "").trim().toUpperCase();
  if (!method) throw new Error("El medio de pago offline es obligatorio.");
  return method;
};

const parseOfflineSalePayments = (
  payload: Record<string, unknown>,
  paymentMethod: string,
  totalAmount: number,
  isCredit: boolean,
) => {
  if (isCredit) return [];

  if (!Array.isArray(payload.payments) || payload.payments.length === 0) {
    return [{ paymentMethod, amount: roundSyncMoney(totalAmount) }];
  }

  const parsedPayments = payload.payments.map((payment) => {
    if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
      throw new Error("Los pagos offline tienen formato invalido.");
    }

    const typedPayment = payment as Record<string, unknown>;
    const method = normalizeSyncPaymentMethod(typedPayment.paymentMethod);
    const amount = Number(typedPayment.amount);

    if (method === "CREDIT_ACCOUNT") {
      throw new Error("La cuenta corriente offline no puede mezclarse con pagos.");
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Cada pago offline debe tener un importe positivo.");
    }

    return { paymentMethod: method, amount: roundSyncMoney(amount) };
  });

  const paidAmount = roundSyncMoney(
    parsedPayments.reduce((sum, payment) => sum + payment.amount, 0),
  );

  if (Math.abs(paidAmount - roundSyncMoney(totalAmount)) > 0.01) {
    throw new Error(
      "La suma de pagos offline no coincide con el total de la venta.",
    );
  }

  return parsedPayments;
};

const resolveOfflineSalePaymentMethod = (
  paymentMethod: string,
  payments: { paymentMethod: string; amount: number }[],
) => {
  if (payments.length === 0) return "CREDIT_ACCOUNT";
  const uniqueMethods = new Set(payments.map((payment) => payment.paymentMethod));
  if (uniqueMethods.size > 1) return "MIXED";
  return payments[0]?.paymentMethod || paymentMethod;
};

const replaySaleOperation = async (
  operation: IncomingSyncOperation,
  authUser: { id: number; role: string; branchIds: number[] },
) => {
  const payload = getPayload(operation);
  const branchId = Number(payload.branchId);
  const cashRegisterId = Number(payload.cashRegisterId);
  const paymentMethod = normalizeSyncPaymentMethod(payload.paymentMethod || "CASH");
  const totalAmount = Number(payload.totalAmount);
  const customerId =
    payload.customerId === null || payload.customerId === undefined
      ? null
      : Number(payload.customerId);
  const pickedUpBy =
    typeof payload.pickedUpBy === "string" ? payload.pickedUpBy : null;
  const items = Array.isArray(payload.items)
    ? (payload.items as Record<string, unknown>[])
    : [];

  ensureBranchAccess(branchId, authUser);

  if (items.length === 0) throw new Error("La venta offline no tiene items.");

  await prisma.$transaction(async (tx) => {
    const cashRegister = await tx.cashRegister.findUnique({
      where: { id: cashRegisterId },
    });

    if (!cashRegister || cashRegister.branchId !== branchId) {
      throw new Error("La caja offline no pertenece a la sucursal indicada.");
    }

    if (cashRegister.status !== "OPEN") {
      throw new Error("Operacion offline denegada: la registradora no esta abierta.");
    }

    const isCredit = paymentMethod === "CREDIT_ACCOUNT";
    const immediatePayments = parseOfflineSalePayments(
      payload,
      paymentMethod,
      totalAmount,
      isCredit,
    );
    const salePaymentMethod = resolveOfflineSalePaymentMethod(
      paymentMethod,
      immediatePayments,
    );
    const sale = await tx.sale.create({
      data: {
        totalAmount,
        paymentMethod: salePaymentMethod,
        status: isCredit ? "PENDING" : "PAID",
        balance: isCredit ? totalAmount : 0,
        pickedUpBy: isCredit ? pickedUpBy : null,
        customerId,
        branchId,
        userId: authUser.id,
        cashRegisterId,
      },
    });

    for (const item of items) {
      const productId = Number(item.productId);
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);

      const stock = await tx.stock.findUnique({
        where: { productId_branchId: { productId, branchId } },
      });

      if (!stock || stock.quantity < quantity) {
        throw new Error(
          `Conflicto de inventario offline: stock insuficiente para producto ${productId}.`,
        );
      }

      await tx.stock.update({
        where: { id: stock.id },
        data: { quantity: stock.quantity - quantity },
      });

      await tx.saleItem.create({
        data: {
          saleId: sale.id,
          productId,
          quantity,
          unitPrice,
          subtotal: quantity * unitPrice,
          unitCost:
            typeof item.unitCost === "number" ? Number(item.unitCost) : 0,
        },
      });

      await tx.movement.create({
        data: {
          type: "OUT",
          quantity,
          reason: `Venta offline sincronizada ${operation.idempotencyKey || operation.id || ""}`,
          productId,
          branchId,
          userId: authUser.id,
        },
      });
    }

    const createdPayments: Payment[] = [];
    for (const payment of immediatePayments) {
      const createdPayment = await tx.payment.create({
        data: {
          amount: payment.amount,
          paymentMethod: payment.paymentMethod,
          saleId: sale.id,
          userId: authUser.id,
          branchId,
          cashRegisterId,
        },
      });
      createdPayments.push(createdPayment);
    }

    await createInternalReceipt(tx, {
      receiptType: "SALE",
      branchId,
      cashRegisterId,
      saleId: sale.id,
      paymentId: createdPayments.length === 1 ? createdPayments[0]?.id : null,
      sourceId: sale.id,
      createdBy: authUser.id,
      payload: {
        saleId: sale.id,
        totalAmount,
        paymentMethod: salePaymentMethod,
        payments: createdPayments.map((payment) => ({
          id: payment.id,
          amount: payment.amount,
          paymentMethod: payment.paymentMethod,
        })),
        paymentsCount: createdPayments.length,
        status: isCredit ? "PENDING" : "PAID",
        balance: isCredit ? totalAmount : 0,
        customerId,
        pickedUpBy: isCredit ? pickedUpBy : null,
        items,
        offlineOperationId: operation.id,
        idempotencyKey: operation.idempotencyKey,
      },
    });
  });
};

const replayExpenseOperation = async (
  operation: IncomingSyncOperation,
  authUser: { id: number; role: string; branchIds: number[] },
) => {
  const payload = getPayload(operation);
  const branchId = Number(payload.branchId);
  const cashRegisterId = Number(payload.cashRegisterId);
  const amount = Number(payload.amount);

  ensureBranchAccess(branchId, authUser);

  if (!Number.isInteger(cashRegisterId) || cashRegisterId <= 0) {
    throw new Error("La operacion offline no tiene una caja valida.");
  }

  await prisma.$transaction(async (tx) => {
    const activeShift = await tx.cashRegister.findUnique({
      where: { id: cashRegisterId },
      include: {
        expenses: true,
        payments: true,
      },
    });

    if (!activeShift || activeShift.status !== "OPEN") {
      throw new Error("Operacion offline denegada: la registradora no esta abierta.");
    }

    if (activeShift.branchId !== branchId) {
      throw new Error("La caja offline no pertenece a la sucursal indicada.");
    }

    const totalCashPayments = activeShift.payments.reduce((acc, payment) => {
      return payment.paymentMethod.toUpperCase() === "CASH"
        ? acc + payment.amount
        : acc;
    }, 0);
    const totalExpenses = activeShift.expenses.reduce(
      (acc, expense) => acc + expense.amount,
      0,
    );
    const availableCash =
      activeShift.initialBalance + totalCashPayments - totalExpenses;

    if (amount > availableCash) {
      throw new Error("No hay efectivo suficiente para sincronizar este egreso.");
    }

    const expense = await tx.expense.create({
      data: {
        amount,
        reason: String(payload.reason || "Egreso offline sincronizado"),
        category: String(payload.category || "OTHER"),
        type: String(payload.type || "VARIABLE"),
        branchId,
        cashRegisterId,
        userId: authUser.id,
      },
    });

    await tx.cashRegister.update({
      where: { id: activeShift.id },
      data: { expectedBalance: availableCash - amount },
    });

    await createInternalReceipt(tx, {
      receiptType: "EXPENSE",
      branchId,
      cashRegisterId,
      sourceId: expense.id,
      createdBy: authUser.id,
      payload: {
        expenseId: expense.id,
        amount,
        reason: String(payload.reason || "Egreso offline sincronizado"),
        category: String(payload.category || "OTHER"),
        type: String(payload.type || "VARIABLE"),
        previousExpectedBalance: availableCash,
        newExpectedBalance: availableCash - amount,
        offlineOperationId: operation.id,
        idempotencyKey: operation.idempotencyKey,
      },
    });
  });
};

const replayStockUpdateOperation = async (
  operation: IncomingSyncOperation,
  authUser: { id: number; role: string; branchIds: number[] },
) => {
  const payload = getPayload(operation);
  const branchId = Number(payload.branchId);
  const productId = Number(payload.productId);
  const quantity = Number(payload.quantity);
  const type = String(payload.type || "ADD");

  ensureBranchAccess(branchId, authUser);

  await prisma.$transaction(async (tx) => {
    const currentStock = await tx.stock.findUnique({
      where: { productId_branchId: { productId, branchId } },
    });

    const nextQuantity =
      type === "SUBTRACT"
        ? (currentStock?.quantity || 0) - quantity
        : (currentStock?.quantity || 0) + quantity;

    if (nextQuantity < 0) {
      throw new Error("Conflicto offline: el ajuste deja stock negativo.");
    }

    await tx.stock.upsert({
      where: { productId_branchId: { productId, branchId } },
      update: { quantity: nextQuantity },
      create: {
        productId,
        branchId,
        quantity: nextQuantity,
        minStock: 5,
      },
    });

    // Normalize to the canonical movement type (same logic as the online updateStock handler)
    const movementType = type === "ADD" ? "IN" : type === "SUBTRACT" ? "OUT" : "ADJUST";

    await tx.movement.create({
      data: {
        type: movementType,
        quantity,
        reason: String(payload.reason || "Ajuste offline sincronizado"),
        productId,
        branchId,
        userId: authUser.id,
      },
    });
  });
};

const replayAccountPaymentOperation = async (
  operation: IncomingSyncOperation,
  authUser: { id: number; role: string; branchIds: number[] },
) => {
  const payload = getPayload(operation);
  const saleId = Number(payload.saleId);
  const cashRegisterId = Number(payload.cashRegisterId);
  const amount = Number(payload.amount);
  const paymentMethod = String(payload.paymentMethod || "").trim().toUpperCase();

  const allowedMethods = new Set(["CASH", "DEBIT", "CREDIT", "TRANSFER", "MIXED"]);

  if (!Number.isInteger(saleId) || saleId <= 0) {
    throw new Error("La operacion offline de cobro no tiene ticket valido.");
  }
  if (!Number.isInteger(cashRegisterId) || cashRegisterId <= 0) {
    throw new Error("La operacion offline de cobro no tiene caja valida.");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("El monto del cobro offline no es valido.");
  }
  if (!allowedMethods.has(paymentMethod)) {
    throw new Error("El medio de pago del cobro offline no es valido.");
  }

  await prisma.$transaction(async (tx) => {
    const activeRegister = await tx.cashRegister.findUnique({
      where: { id: cashRegisterId },
    });

    if (!activeRegister || activeRegister.status !== "OPEN") {
      throw new Error("Cobro offline rechazado: la caja ya no está abierta.");
    }

    ensureBranchAccess(activeRegister.branchId, authUser);

    const targetSale = await tx.sale.findUnique({ where: { id: saleId } });

    if (!targetSale) throw new Error("Ticket de cuenta corriente no encontrado.");
    if (targetSale.status === "PAID" || targetSale.balance <= 0) {
      throw new Error("Esta cuenta corriente ya se encuentra saldada.");
    }
    if (targetSale.branchId !== activeRegister.branchId) {
      throw new Error("La caja y la cuenta corriente pertenecen a sucursales distintas.");
    }
    if (amount > targetSale.balance) {
      throw new Error(
        `Cobro offline rechazado: el monto ($${amount}) supera el saldo ($${targetSale.balance}).`,
      );
    }

    const newBalance = roundSyncMoney(targetSale.balance - amount);
    const newStatus = newBalance === 0 ? "PAID" : "PARTIAL";

    await tx.sale.update({
      where: { id: targetSale.id },
      data: { balance: newBalance, status: newStatus },
    });

    const newPayment = await tx.payment.create({
      data: {
        amount,
        paymentMethod,
        saleId: targetSale.id,
        userId: authUser.id,
        branchId: targetSale.branchId,
        cashRegisterId: activeRegister.id,
      },
    });

    await createInternalReceipt(tx, {
      receiptType: "PAYMENT",
      branchId: targetSale.branchId,
      cashRegisterId: activeRegister.id,
      saleId: targetSale.id,
      paymentId: newPayment.id,
      sourceId: newPayment.id,
      createdBy: authUser.id,
      payload: {
        paymentId: newPayment.id,
        saleId: targetSale.id,
        amount,
        paymentMethod,
        previousBalance: targetSale.balance,
        newBalance,
        status: newStatus,
        offlineOperationId: operation.id,
        idempotencyKey: operation.idempotencyKey,
      },
    });
  });
};

const replayCustomerCreateOperation = async (
  operation: IncomingSyncOperation,
  authUser: { id: number; role: string; branchIds: number[] },
) => {
  const payload = getPayload(operation);
  const branchId = resolveOperationBranchId(operation);
  const name = String(payload.name || "").trim();
  const document = String(payload.document || "").trim() || null;
  const email = String(payload.email || "").trim() || null;
  const customerType = String(payload.type || "CONSUMER").trim() || "CONSUMER";

  if (branchId) {
    ensureBranchAccess(branchId, authUser);
  } else if (authUser.role !== "ADMIN") {
    throw new Error("La alta offline de cliente requiere una sucursal valida.");
  }

  if (name.length < 2) {
    throw new Error("La alta offline de cliente no tiene nombre valido.");
  }

  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("El email del cliente offline no es valido.");
  }

  if (document) {
    const existingCustomer = await prisma.customer.findUnique({
      where: { document },
    });

    if (existingCustomer) {
      throw new Error(
        `Ya existe un cliente registrado con el documento/CUIT ${document}.`,
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        name,
        document,
        type: customerType,
        phone: String(payload.phone || "").trim() || null,
        email,
        address: String(payload.address || "").trim() || null,
      },
    });

    await tx.auditLog.create({
      data: {
        actorUserId: authUser.id,
        branchId,
        action: "customer.created",
        entityType: "Customer",
        entityId: String(customer.id),
        metadata: toJsonPayload({
          name: customer.name,
          document: customer.document,
          type: customer.type,
          source: "offline-sync",
          offlineOperationId: operation.id,
          idempotencyKey: operation.idempotencyKey,
        }),
      },
    });
  });
};

const replayOperation = async (
  operation: IncomingSyncOperation,
  authUser: { id: number; role: string; branchIds: number[] },
) => {
  const endpoint = String(operation.endpoint || "");
  const method = String(operation.method || "").toUpperCase();

  if (method === "POST" && endpoint === "/sales") {
    await replaySaleOperation(operation, authUser);
    return;
  }

  if (method === "POST" && endpoint === "/expenses") {
    await replayExpenseOperation(operation, authUser);
    return;
  }

  if (method === "PUT" && endpoint === "/stock/update") {
    await replayStockUpdateOperation(operation, authUser);
    return;
  }

  if (method === "POST" && endpoint === "/customers") {
    await replayCustomerCreateOperation(operation, authUser);
    return;
  }

  if (method === "POST" && endpoint === "/payments/account") {
    await replayAccountPaymentOperation(operation, authUser);
    return;
  }

  throw new Error(`Operacion offline no soportada todavia: ${method} ${endpoint}`);
};

/**
 * GET /sync/pull
 *
 * Returns a full offline data snapshot for the requesting device and branch.
 * The snapshot includes: products (with stock), customers, and an optional
 * open cash register. Persists the pull event as a `SyncOperation` record.
 *
 * Clients should call this on: initial load, reconnect, and branch switch.
 *
 * @query branchId  - Target branch ID.
 * @query deviceId  - Unique device identifier (generated client-side).
 * @query checkpoint - Optional: ISO timestamp for incremental pulls (future use).
 */
export const pullSyncSnapshot = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.query.branchId || 0);
    const deviceId = resolveSyncDeviceId(req);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    const branchWhere = resolveBranchWhere(branchId, authUser);
    const branchFilter =
      branchWhere === undefined ? undefined : { id: branchWhere };
    const scopedStockWhere =
      branchWhere === undefined ? undefined : { branchId: branchWhere };

    const [branches, products, customers, suppliers, openCashRegisters] =
      await Promise.all([
        prisma.branch.findMany({
          where: branchFilter,
          orderBy: { name: "asc" },
        }),
        prisma.product.findMany({
          where: { isActive: true },
          include: {
            stocks:
              scopedStockWhere === undefined
                ? true
                : { where: scopedStockWhere },
          },
          orderBy: { updatedAt: "desc" },
          take: 3000,
        }),
        prisma.customer.findMany({
          where: { isActive: true },
          orderBy: { updatedAt: "desc" },
          take: 3000,
        }),
        prisma.supplier.findMany({
          where: { isActive: true },
          orderBy: { updatedAt: "desc" },
          take: 1000,
        }),
        prisma.cashRegister.findMany({
          where: {
            status: "OPEN",
            ...(scopedStockWhere ? { branchId: scopedStockWhere.branchId } : {}),
          },
          orderBy: { openingTime: "desc" },
        }),
      ]);

    const checkpointAt = new Date();
    const syncCheckpoint = await persistSyncCheckpoint({
      deviceId,
      userId: authUser.id,
      branchId: checkpointBranchIdFromScope(branchId),
      lastPulledAt: checkpointAt,
    });

    res.status(200).json({
      serverTime: checkpointAt.toISOString(),
      checkpoint: checkpointAt.toISOString(),
      scope: { branchId, deviceId },
      syncCheckpoint,
      data: {
        branches,
        products,
        customers,
        suppliers,
        openCashRegisters,
      },
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error ? error.message : "No se pudo sincronizar datos.";
    res.status(400).json({ error: errorMsg });
  }
};

/**
 * GET /sync/status
 *
 * Returns the list of recent sync operations for the requesting device and branch.
 * Used by the frontend `/sync` page and the header status badge to show pending,
 * processing, accepted, and rejected operations.
 *
 * @query branchId - Branch filter (0 = all branches visible to the user).
 * @query deviceId - Device identifier to scope results to the current device.
 * @query limit    - Max records to return (default: 20, max: 100).
 */
export const getSyncStatus = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const branchId = Number(req.query.branchId || 0);
    const deviceId = resolveSyncDeviceId(req);
    const limit = resolveStatusLimit(req.query.limit);

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    if (authUser.role === "EMPLOYEE") {
      return res.status(403).json({
        error:
          "El estado global de sincronizacion queda reservado para encargados y administradores.",
      });
    }

    const branchWhere = resolveBranchWhere(branchId, authUser);
    const operationWhere: Prisma.SyncOperationWhereInput =
      branchWhere === undefined ? {} : { branchId: branchWhere };
    const checkpointWhere: Prisma.SyncCheckpointWhereInput = {
      userId: authUser.id,
      ...(branchWhere === undefined ? {} : { branchId: branchWhere }),
    };

    const [operations, counterRows, checkpoints] = await Promise.all([
      prisma.syncOperation.findMany({
        where: operationWhere,
        orderBy: { createdAt: "desc" },
        take: limit,
      }),
      prisma.syncOperation.groupBy({
        by: ["status"],
        where: operationWhere,
        _count: { _all: true },
      }),
      prisma.syncCheckpoint.findMany({
        where: checkpointWhere,
        orderBy: { updatedAt: "desc" },
        take: 25,
      }),
    ]);

    const countersByStatus = counterRows.reduce<Record<string, number>>(
      (acc, row) => {
        acc[row.status] = row._count._all;
        return acc;
      },
      {},
    );

    res.status(200).json({
      serverTime: new Date().toISOString(),
      scope: { branchId, deviceId, limit },
      operations,
      checkpoints,
      counters: {
        accepted: countersByStatus[SYNC_STATUS_ACCEPTED] || 0,
        rejected: countersByStatus[SYNC_STATUS_REJECTED] || 0,
        processing: countersByStatus[SYNC_STATUS_PROCESSING] || 0,
        pending: countersByStatus.PENDING || 0,
        total: counterRows.reduce((acc, row) => acc + row._count._all, 0),
      },
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : "No se pudo consultar el estado de sincronizacion.";
    res.status(400).json({ error: errorMsg });
  }
};

/**
 * POST /sync/push
 *
 * Receives a batch of offline operations queued by the device and applies them
 * to the live database. Each operation is processed idempotently:
 * - If `idempotencyKey` already exists with status ACCEPTED → silently skip.
 * - If processing succeeds → mark ACCEPTED, return in `acceptedOperationIds`.
 * - If processing fails → mark REJECTED, return in `rejectedOperations` with an error.
 *
 * Currently supported operation types:
 * - `SALE_CREATE` — creates a sale with stock deduction
 * - `EXPENSE_CREATE` — registers an expense against an open shift
 *
 * The device is responsible for deleting accepted operations and displaying
 * rejected ones to the operator for manual resolution.
 *
 * @body branchId    - Branch the operations belong to.
 * @body deviceId    - Identifier of the sending device.
 * @body operations  - Array of `IncomingSyncOperation` objects.
 */
export const pushSyncOperations = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    const requestedBranchId = Number(req.body.branchId || 0);
    const deviceId = resolveSyncDeviceId(req);
    const operations = Array.isArray(req.body.operations)
      ? (req.body.operations as IncomingSyncOperation[])
      : [];

    if (!authUser) {
      return res.status(401).json({
        error: "No se pudo validar la identidad del usuario.",
      });
    }

    if (requestedBranchId > 0) {
      resolveBranchWhere(requestedBranchId, authUser);
    }

    const acceptedOperationIds: string[] = [];
    const rejectedOperations: { id?: string; error: string }[] = [];

    for (const operation of operations) {
      const operationId = operation.id || operation.idempotencyKey;
      const branchId = resolveOperationBranchId(operation);
      const descriptor = getOperationDescriptor(operation);

      if (!operationId) {
        rejectedOperations.push({
          error: "La operacion offline no tiene idempotencyKey.",
        });
        continue;
      }

      // Reject malformed idempotency keys to prevent injection into queries.
      // Valid format: 8–120 alphanumeric chars, hyphens, or underscores.
      if (!/^[\w\-]{8,120}$/.test(operationId)) {
        rejectedOperations.push({
          id: operationId,
          error: "El idempotencyKey tiene un formato no valido.",
        });
        continue;
      }

      if (
        branchId &&
        authUser.role !== "ADMIN" &&
        !authUser.branchIds.includes(branchId)
      ) {
        rejectedOperations.push({
          id: operationId,
          error: "La operacion apunta a una sucursal no autorizada.",
        });
        continue;
      }

      try {
        const existingOperation = await prisma.syncOperation.findUnique({
          where: { idempotencyKey: operationId },
        });

        if (existingOperation?.status === SYNC_STATUS_ACCEPTED) {
          acceptedOperationIds.push(operationId);
          continue;
        }

        if (existingOperation?.status === SYNC_STATUS_REJECTED) {
          rejectedOperations.push({
            id: operationId,
            error:
              existingOperation.error ||
              "La operacion ya habia sido rechazada por el servidor.",
          });
          continue;
        }

        await prisma.syncOperation.upsert({
          where: { idempotencyKey: operationId },
          update: {
            branchId,
            userId: authUser.id,
            type: descriptor,
            status: SYNC_STATUS_PROCESSING,
            payload: toJsonPayload(operation.payload),
            error: null,
            processedAt: null,
          },
          create: {
            idempotencyKey: operationId,
            branchId,
            userId: authUser.id,
            type: descriptor,
            status: SYNC_STATUS_PROCESSING,
            payload: toJsonPayload(operation.payload),
          },
        });

        await replayOperation(operation, authUser);

        await prisma.syncOperation.update({
          where: { idempotencyKey: operationId },
          data: {
            status: SYNC_STATUS_ACCEPTED,
            error: null,
            processedAt: new Date(),
          },
        });

        await recordSyncAudit(
          "sync.operation.accepted",
          authUser,
          operationId,
          branchId,
          { descriptor },
        );

        acceptedOperationIds.push(operationId);
      } catch (error: unknown) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "No se pudo reproducir la operacion offline.";

        await prisma.syncOperation
          .upsert({
            where: { idempotencyKey: operationId },
            update: {
              branchId,
              userId: authUser.id,
              type: descriptor,
              status: SYNC_STATUS_REJECTED,
              payload: toJsonPayload(operation.payload),
              error: errorMessage,
              processedAt: new Date(),
            },
            create: {
              idempotencyKey: operationId,
              branchId,
              userId: authUser.id,
              type: descriptor,
              status: SYNC_STATUS_REJECTED,
              payload: toJsonPayload(operation.payload),
              error: errorMessage,
              processedAt: new Date(),
            },
          })
          .catch((syncPersistenceError: unknown) => {
            logger.warn(
              "No se pudo persistir el rechazo de sync:",
              syncPersistenceError,
            );
          });

        await recordSyncAudit(
          "sync.operation.rejected",
          authUser,
          operationId,
          branchId,
          { descriptor, error: errorMessage },
        );

        rejectedOperations.push({
          id: operationId,
          error: errorMessage,
        });
      }
    }

    const checkpointAt = new Date();
    const syncCheckpoint = await persistSyncCheckpoint({
      deviceId,
      userId: authUser.id,
      branchId: checkpointBranchIdFromScope(requestedBranchId),
      lastPushedAt: checkpointAt,
    });

    res.status(202).json({
      message:
        "Operaciones offline procesadas por el motor de sincronizacion.",
      acceptedOperationIds,
      rejectedOperations,
      serverTime: checkpointAt.toISOString(),
      scope: { branchId: requestedBranchId, deviceId },
      syncCheckpoint,
    });
  } catch (error) {
    logger.error("Error en push de sincronizacion:", error);
    res.status(500).json({ error: "Fallo al recibir operaciones offline." });
  }
};

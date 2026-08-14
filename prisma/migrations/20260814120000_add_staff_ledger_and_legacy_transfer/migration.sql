-- FASE 7: el libro del personal, el consumo interno y el traslado legado.
--
-- Aditiva pura: seis enums, siete tablas y dos columnas con DEFAULT en `Sale`.
-- Ninguna fila existente cambia de valor y el código desplegado hoy las ignora.
--
-- ── Lo que este modelo corrige de dos versiones mías rechazadas ─────────────
--
-- 1. NO SE FALSIFICA EL HISTÓRICO. Mi primera propuesta ponía status='PAID' y
--    balance=0 en las ventas legado, declarando cobrado lo que nunca se cobró.
--    Acá `status`, `balance`, los pagos y las devoluciones quedan INTACTOS: sólo
--    se registra cuánto se trasladó, en columnas nuevas.
--
-- 2. UN TRASLADO REVERTIDO SE PUEDE REHACER. La segunda versión tenía
--    `saleId @unique` y a la vez prometía re-trasladar tras una reversión
--    total: la base habría rechazado el segundo registro. Se resuelve con
--    `cycleNumber` + un índice parcial de "un solo ciclo VIVO por venta".
--
-- ── Nada de CONCURRENTLY ────────────────────────────────────────────────────
--
-- PostgreSQL lo prohíbe dentro del bloque transaccional que Prisma abre por
-- migración (error 25001). Y no hace falta: son tablas recién creadas, con cero
-- filas, y `Sale` tiene 41 en producción (medido).

-- CreateEnum
CREATE TYPE "StaffLedgerEntryType" AS ENUM ('OPENING_BALANCE', 'CONSUMPTION', 'ADJUSTMENT_DEBIT', 'PAYMENT', 'PAYROLL_DEDUCTION', 'RETURN_CREDIT', 'TRANSFER_REVERSAL', 'ADJUSTMENT_CREDIT');

-- CreateEnum
CREATE TYPE "InternalConsumptionKind" AS ENUM ('EMPLOYEE_PERSONAL', 'COMPANY_USE');

-- CreateEnum
CREATE TYPE "InternalPricePolicy" AS ENUM ('RETAIL', 'COST', 'COST_PLUS', 'STAFF_DISCOUNT', 'EXPLICIT');

-- CreateEnum
CREATE TYPE "StaffPaymentMethod" AS ENUM ('CASH', 'TRANSFER', 'PAYROLL_DEDUCTION', 'MERCHANDISE_RETURN', 'WRITE_OFF');

-- CreateEnum
CREATE TYPE "LegacyLinkStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'REJECTED');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('ACTIVE', 'PARTIALLY_REVERSED', 'FULLY_REVERSED');

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "transferReversed" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "transferredToStaffLedger" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "StaffAccount" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "creditLimit" DECIMAL(14,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffLedgerEntry" (
    "id" SERIAL NOT NULL,
    "staffAccountId" INTEGER NOT NULL,
    "type" "StaffLedgerEntryType" NOT NULL,
    "debit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "sourceType" TEXT,
    "sourceId" INTEGER,
    "reversalOfId" INTEGER,
    "reason" TEXT NOT NULL,
    "createdById" INTEGER NOT NULL,
    "authorizedById" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,

    CONSTRAINT "StaffLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalConsumption" (
    "id" SERIAL NOT NULL,
    "kind" "InternalConsumptionKind" NOT NULL,
    "branchId" INTEGER NOT NULL,
    "terminalId" INTEGER,
    "cashRegisterId" INTEGER,
    "staffAccountId" INTEGER,
    "purpose" TEXT,
    "pricePolicy" "InternalPricePolicy" NOT NULL DEFAULT 'RETAIL',
    "pricePolicyRate" DECIMAL(7,4),
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "totalCost" DECIMAL(14,2) NOT NULL,
    "createdById" INTEGER NOT NULL,
    "authorizedById" INTEGER,
    "reason" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InternalConsumption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalConsumptionItem" (
    "id" SERIAL NOT NULL,
    "consumptionId" INTEGER NOT NULL,
    "productId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "listPrice" DECIMAL(14,4) NOT NULL,
    "unitPrice" DECIMAL(14,4) NOT NULL,
    "unitCost" DECIMAL(14,4),
    "subtotal" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "InternalConsumptionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffPaymentSettlement" (
    "id" SERIAL NOT NULL,
    "staffAccountId" INTEGER NOT NULL,
    "method" "StaffPaymentMethod" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "cashRegisterId" INTEGER,
    "branchId" INTEGER,
    "reference" TEXT,
    "payrollRecordId" INTEGER,
    "createdById" INTEGER NOT NULL,
    "authorizedById" INTEGER,
    "reason" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffPaymentSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaffAccountLegacyLink" (
    "id" SERIAL NOT NULL,
    "staffAccountId" INTEGER NOT NULL,
    "legacyCustomerId" INTEGER NOT NULL,
    "status" "LegacyLinkStatus" NOT NULL DEFAULT 'PROPOSED',
    "transferredTotal" DECIMAL(14,2),
    "reason" TEXT NOT NULL,
    "proposedById" INTEGER NOT NULL,
    "confirmedById" INTEGER,
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAccountLegacyLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacySaleTransfer" (
    "id" SERIAL NOT NULL,
    "legacyLinkId" INTEGER NOT NULL,
    "saleId" INTEGER NOT NULL,
    "cycleNumber" INTEGER NOT NULL,
    "originalStatus" TEXT NOT NULL,
    "originalBalance" DECIMAL(14,2) NOT NULL,
    "transferredAmount" DECIMAL(14,2) NOT NULL,
    "reversedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" "TransferStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacySaleTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffAccount_userId_key" ON "StaffAccount"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffLedgerEntry_idempotencyKey_key" ON "StaffLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StaffLedgerEntry_staffAccountId_createdAt_idx" ON "StaffLedgerEntry"("staffAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "StaffLedgerEntry_sourceType_sourceId_idx" ON "StaffLedgerEntry"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "InternalConsumption_idempotencyKey_key" ON "InternalConsumption"("idempotencyKey");

-- CreateIndex
CREATE INDEX "InternalConsumption_staffAccountId_createdAt_idx" ON "InternalConsumption"("staffAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "InternalConsumption_branchId_createdAt_idx" ON "InternalConsumption"("branchId", "createdAt");

-- CreateIndex
CREATE INDEX "InternalConsumption_kind_createdAt_idx" ON "InternalConsumption"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "InternalConsumptionItem_consumptionId_idx" ON "InternalConsumptionItem"("consumptionId");

-- CreateIndex
CREATE INDEX "InternalConsumptionItem_productId_idx" ON "InternalConsumptionItem"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffPaymentSettlement_idempotencyKey_key" ON "StaffPaymentSettlement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "StaffPaymentSettlement_staffAccountId_createdAt_idx" ON "StaffPaymentSettlement"("staffAccountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAccountLegacyLink_legacyCustomerId_key" ON "StaffAccountLegacyLink"("legacyCustomerId");

-- CreateIndex
CREATE INDEX "StaffAccountLegacyLink_staffAccountId_idx" ON "StaffAccountLegacyLink"("staffAccountId");

-- CreateIndex
CREATE INDEX "LegacySaleTransfer_legacyLinkId_idx" ON "LegacySaleTransfer"("legacyLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "LegacySaleTransfer_saleId_cycleNumber_key" ON "LegacySaleTransfer"("saleId", "cycleNumber");

-- AddForeignKey
ALTER TABLE "StaffAccount" ADD CONSTRAINT "StaffAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLedgerEntry" ADD CONSTRAINT "StaffLedgerEntry_staffAccountId_fkey" FOREIGN KEY ("staffAccountId") REFERENCES "StaffAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffLedgerEntry" ADD CONSTRAINT "StaffLedgerEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "StaffLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalConsumption" ADD CONSTRAINT "InternalConsumption_staffAccountId_fkey" FOREIGN KEY ("staffAccountId") REFERENCES "StaffAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalConsumptionItem" ADD CONSTRAINT "InternalConsumptionItem_consumptionId_fkey" FOREIGN KEY ("consumptionId") REFERENCES "InternalConsumption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffPaymentSettlement" ADD CONSTRAINT "StaffPaymentSettlement_staffAccountId_fkey" FOREIGN KEY ("staffAccountId") REFERENCES "StaffAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAccountLegacyLink" ADD CONSTRAINT "StaffAccountLegacyLink_staffAccountId_fkey" FOREIGN KEY ("staffAccountId") REFERENCES "StaffAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacySaleTransfer" ADD CONSTRAINT "LegacySaleTransfer_legacyLinkId_fkey" FOREIGN KEY ("legacyLinkId") REFERENCES "StaffAccountLegacyLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ══════════════════════════════════════════════════════════════════════════
-- INVARIANTES IMPUESTOS POR LA BASE
-- ══════════════════════════════════════════════════════════════════════════
--
-- Prisma no sabe expresar índices únicos PARCIALES. Tienen que vivir en la
-- base y no en el código: un `findFirst` seguido de un `create` deja una
-- ventana entre los dos, y acá lo que se cuela por el medio es plata mal
-- imputada. El índice no tiene ventana. (Prisma los ignora, así que
-- `migrate diff` sigue limpio.)

-- Un solo ciclo VIVO por venta.
--
-- Es el corazón de la corrección: dos traslados activos sobre la misma venta
-- duplicarían la deuda de una persona. Un ciclo FULLY_REVERSED queda archivado
-- e inmutable y sale del índice, así que la venta puede re-trasladarse.
CREATE UNIQUE INDEX "legacy_transfer_one_live_cycle_per_sale"
  ON "LegacySaleTransfer"("saleId")
  WHERE status IN ('ACTIVE', 'PARTIALLY_REVERSED');

-- Un solo vínculo CONFIRMADO por cuenta legado a la vez.
--
-- Puede tener varios históricos —se vinculó mal, se revirtió, se vinculó a otra
-- persona— pero dos confirmados simultáneos significarían que la misma deuda
-- vieja se le está cobrando a dos empleados.
CREATE UNIQUE INDEX "legacy_link_one_confirmed_per_customer"
  ON "StaffAccountLegacyLink"("legacyCustomerId")
  WHERE status = 'CONFIRMED';

-- CreateEnum
CREATE TYPE "IncentiveCadence" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "IncentiveEligibilityPolicy" AS ENUM ('ON_SALE', 'ON_COLLECTION', 'MIXED');

-- CreateEnum
CREATE TYPE "IncentiveRuleKind" AS ENUM ('PERCENT_OF_SALES', 'TIERED_PERCENT', 'FIXED_ON_TARGET');

-- CreateEnum
CREATE TYPE "IncentivePeriodStatus" AS ENUM ('DRAFT', 'CALCULATED', 'REVIEWED', 'APPROVED', 'LOCKED', 'PAID');

-- CreateEnum
CREATE TYPE "IncentiveEntryStatus" AS ENUM ('PROVISIONAL', 'ELIGIBLE', 'REVERSED');

-- CreateTable
CREATE TABLE "IncentivePlan" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "cadence" "IncentiveCadence" NOT NULL DEFAULT 'MONTHLY',
    "eligibilityPolicy" "IncentiveEligibilityPolicy" NOT NULL DEFAULT 'MIXED',
    "minMarginPct" DECIMAL(7,4),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncentivePlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncentiveRule" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "kind" "IncentiveRuleKind" NOT NULL,
    "percent" DECIMAL(7,4),
    "fromAmount" DECIMAL(14,2),
    "toAmount" DECIMAL(14,2),
    "fixedAmount" DECIMAL(14,2),
    "targetAmount" DECIMAL(14,2),
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncentiveRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncentivePeriod" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" "IncentivePeriodStatus" NOT NULL DEFAULT 'DRAFT',
    "calculatedAt" TIMESTAMP(3),
    "approvedById" INTEGER,
    "approvedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IncentivePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesTarget" (
    "id" SERIAL NOT NULL,
    "periodId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "branchId" INTEGER,
    "targetAmount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncentiveLedgerEntry" (
    "id" SERIAL NOT NULL,
    "periodId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "saleId" INTEGER,
    "status" "IncentiveEntryStatus" NOT NULL DEFAULT 'PROVISIONAL',
    "baseAmount" DECIMAL(14,2) NOT NULL,
    "commissionAmount" DECIMAL(14,2) NOT NULL,
    "ruleSnapshot" JSONB NOT NULL,
    "marginKnown" BOOLEAN NOT NULL DEFAULT true,
    "eligibleAt" TIMESTAMP(3),
    "reversalOfId" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idempotencyKey" TEXT,

    CONSTRAINT "IncentiveLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IncentiveSettlement" (
    "id" SERIAL NOT NULL,
    "periodId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "totalAmount" DECIMAL(14,2) NOT NULL,
    "payrollRecordId" INTEGER,
    "approvedById" INTEGER NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IncentiveSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IncentivePlan_isActive_effectiveFrom_idx" ON "IncentivePlan"("isActive", "effectiveFrom");

-- CreateIndex
CREATE INDEX "IncentiveRule_planId_effectiveFrom_idx" ON "IncentiveRule"("planId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "IncentivePeriod_status_idx" ON "IncentivePeriod"("status");

-- CreateIndex
CREATE INDEX "IncentivePeriod_startsAt_endsAt_idx" ON "IncentivePeriod"("startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "IncentivePeriod_planId_key_key" ON "IncentivePeriod"("planId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SalesTarget_periodId_userId_key" ON "SalesTarget"("periodId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "IncentiveLedgerEntry_idempotencyKey_key" ON "IncentiveLedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "IncentiveLedgerEntry_periodId_userId_status_idx" ON "IncentiveLedgerEntry"("periodId", "userId", "status");

-- CreateIndex
CREATE INDEX "IncentiveLedgerEntry_saleId_idx" ON "IncentiveLedgerEntry"("saleId");

-- CreateIndex
CREATE INDEX "IncentiveLedgerEntry_userId_status_idx" ON "IncentiveLedgerEntry"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IncentiveSettlement_payrollRecordId_key" ON "IncentiveSettlement"("payrollRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "IncentiveSettlement_idempotencyKey_key" ON "IncentiveSettlement"("idempotencyKey");

-- CreateIndex
CREATE INDEX "IncentiveSettlement_userId_idx" ON "IncentiveSettlement"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "IncentiveSettlement_periodId_userId_key" ON "IncentiveSettlement"("periodId", "userId");

-- AddForeignKey
ALTER TABLE "IncentiveRule" ADD CONSTRAINT "IncentiveRule_planId_fkey" FOREIGN KEY ("planId") REFERENCES "IncentivePlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncentivePeriod" ADD CONSTRAINT "IncentivePeriod_planId_fkey" FOREIGN KEY ("planId") REFERENCES "IncentivePlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesTarget" ADD CONSTRAINT "SalesTarget_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "IncentivePeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncentiveLedgerEntry" ADD CONSTRAINT "IncentiveLedgerEntry_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "IncentivePeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncentiveLedgerEntry" ADD CONSTRAINT "IncentiveLedgerEntry_reversalOfId_fkey" FOREIGN KEY ("reversalOfId") REFERENCES "IncentiveLedgerEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IncentiveSettlement" ADD CONSTRAINT "IncentiveSettlement_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "IncentivePeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

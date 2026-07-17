-- Discount authorization mode + single-use per-sale codes.
-- Additive and idempotent, following the project's Neon-no-backups rule.

ALTER TABLE "AppSetting"
  ADD COLUMN IF NOT EXISTS "discountCodeMode" TEXT NOT NULL DEFAULT 'DAILY';

CREATE TABLE IF NOT EXISTS "DiscountToken" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DiscountToken_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DiscountToken_branchId_code_idx" ON "DiscountToken"("branchId", "code");
CREATE INDEX IF NOT EXISTS "DiscountToken_expiresAt_idx" ON "DiscountToken"("expiresAt");

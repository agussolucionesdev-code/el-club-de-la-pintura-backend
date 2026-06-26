-- Card reconciliation metadata on Sale — strictly additive, idempotent.
-- The terminal (Posnet / MercadoPago Point) is separate; the system never
-- stores the full card number. These fields are for reconciling the coupon.
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "cardBrand" TEXT;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "cardLast4" TEXT;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "cardInstallments" INTEGER;
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "cardSurchargePct" DECIMAL(7,4);
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "couponNumber" TEXT;

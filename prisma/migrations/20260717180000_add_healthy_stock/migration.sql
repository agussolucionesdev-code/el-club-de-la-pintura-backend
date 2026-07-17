-- The stock level the owner wants to keep per product ("Sano desde").
-- Additive and idempotent. Default 0 = unset, which preserves the previous
-- behaviour exactly: anything above minStock reads as healthy.
ALTER TABLE "Stock" ADD COLUMN IF NOT EXISTS "healthyStock" INTEGER NOT NULL DEFAULT 0;

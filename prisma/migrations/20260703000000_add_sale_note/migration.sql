-- Optional note on the sale ticket — strictly additive, idempotent.
ALTER TABLE "Sale" ADD COLUMN IF NOT EXISTS "note" TEXT;

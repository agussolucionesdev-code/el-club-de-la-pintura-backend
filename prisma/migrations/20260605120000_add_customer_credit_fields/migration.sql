-- AddColumn: Customer.creditLimit
-- AddColumn: Customer.defaultDiscount
-- These fields were previously added at runtime via ensureCustomerCreditFields().
-- This migration makes them part of the proper migration history.
ALTER TABLE "Customer"
  ADD COLUMN IF NOT EXISTS "creditLimit"     INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "defaultDiscount" INTEGER NOT NULL DEFAULT 0;

-- Manual cash movements (ingreso/retiro de efectivo sin venta).
-- Additive + idempotent: safe to run repeatedly, never drops data.

CREATE TABLE IF NOT EXISTS "CashMovement" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "cashRegisterId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CashMovement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CashMovement_cashRegisterId_idx"
  ON "CashMovement"("cashRegisterId");
CREATE INDEX IF NOT EXISTS "CashMovement_branchId_createdAt_idx"
  ON "CashMovement"("branchId", "createdAt");

-- Foreign keys (guarded so a partial apply never fails the release).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'CashMovement_cashRegisterId_fkey'
      AND table_name = 'CashMovement'
  ) THEN
    ALTER TABLE "CashMovement"
      ADD CONSTRAINT "CashMovement_cashRegisterId_fkey"
      FOREIGN KEY ("cashRegisterId") REFERENCES "CashRegister"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'CashMovement_userId_fkey'
      AND table_name = 'CashMovement'
  ) THEN
    ALTER TABLE "CashMovement"
      ADD CONSTRAINT "CashMovement_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'CashMovement_branchId_fkey'
      AND table_name = 'CashMovement'
  ) THEN
    ALTER TABLE "CashMovement"
      ADD CONSTRAINT "CashMovement_branchId_fkey"
      FOREIGN KEY ("branchId") REFERENCES "Branch"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

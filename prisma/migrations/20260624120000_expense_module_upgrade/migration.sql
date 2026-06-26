-- Expense module upgrade — strictly additive (idempotent, safe without backups).

-- ── Expense: soft-void, receipt image, supplier link, recurring ref ──
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "voidReason" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "voidedById" INTEGER;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "receiptImageUrl" TEXT;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "supplierId" INTEGER;
ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "recurringExpenseId" INTEGER;

-- FK Expense.supplierId -> Supplier.id (nullable, set null on delete)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Expense_supplierId_fkey' AND table_name = 'Expense'
  ) THEN
    ALTER TABLE "Expense"
      ADD CONSTRAINT "Expense_supplierId_fkey"
      FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "Expense_voidedAt_idx" ON "Expense"("voidedAt");
CREATE INDEX IF NOT EXISTS "Expense_supplierId_idx" ON "Expense"("supplierId");

-- ── ExpenseBudget ──
CREATE TABLE IF NOT EXISTS "ExpenseBudget" (
    "id" SERIAL NOT NULL,
    "branchId" INTEGER,
    "category" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'MONTHLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExpenseBudget_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ExpenseBudget_branchId_category_key" ON "ExpenseBudget"("branchId", "category");

-- ── RecurringExpense ──
CREATE TABLE IF NOT EXISTS "RecurringExpense" (
    "id" SERIAL NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'VARIABLE',
    "frequency" TEXT NOT NULL DEFAULT 'MONTHLY',
    "branchId" INTEGER NOT NULL,
    "supplierId" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "RecurringExpense_branchId_active_idx" ON "RecurringExpense"("branchId", "active");

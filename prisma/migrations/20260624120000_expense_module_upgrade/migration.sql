-- Expense module upgrade — strictly additive (safe without backups).

-- ── Expense: soft-void, receipt image, supplier link, recurring ref ──
ALTER TABLE "Expense" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "Expense" ADD COLUMN "voidReason" TEXT;
ALTER TABLE "Expense" ADD COLUMN "voidedById" INTEGER;
ALTER TABLE "Expense" ADD COLUMN "receiptImageUrl" TEXT;
ALTER TABLE "Expense" ADD COLUMN "supplierId" INTEGER;
ALTER TABLE "Expense" ADD COLUMN "recurringExpenseId" INTEGER;

-- FK Expense.supplierId -> Supplier.id (nullable, set null on delete)
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Expense_voidedAt_idx" ON "Expense"("voidedAt");
CREATE INDEX "Expense_supplierId_idx" ON "Expense"("supplierId");

-- ── ExpenseBudget ──
CREATE TABLE "ExpenseBudget" (
    "id" SERIAL NOT NULL,
    "branchId" INTEGER,
    "category" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'MONTHLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExpenseBudget_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExpenseBudget_branchId_category_key" ON "ExpenseBudget"("branchId", "category");

-- ── RecurringExpense ──
CREATE TABLE "RecurringExpense" (
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
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RecurringExpense_branchId_active_idx" ON "RecurringExpense"("branchId", "active");

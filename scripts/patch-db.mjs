/**
 * One-shot idempotent patch for the expense module upgrade.
 * Runs before prisma migrate deploy to ensure tables and columns exist
 * regardless of the migration history state in _prisma_migrations.
 */
import pg from 'pg';
const { Client } = pg;

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

console.log('[patch-db] Applying idempotent expense module schema...');

const statements = [
  // Expense new columns
  `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3)`,
  `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "voidReason" TEXT`,
  `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "voidedById" INTEGER`,
  `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "receiptImageUrl" TEXT`,
  `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "supplierId" INTEGER`,
  `ALTER TABLE "Expense" ADD COLUMN IF NOT EXISTS "recurringExpenseId" INTEGER`,

  // FK Expense.supplierId -> Supplier.id
  `DO $$ BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.table_constraints
      WHERE constraint_name = 'Expense_supplierId_fkey' AND table_name = 'Expense'
    ) THEN
      ALTER TABLE "Expense"
        ADD CONSTRAINT "Expense_supplierId_fkey"
        FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
  END $$`,

  // Indexes
  `CREATE INDEX IF NOT EXISTS "Expense_voidedAt_idx" ON "Expense"("voidedAt")`,
  `CREATE INDEX IF NOT EXISTS "Expense_supplierId_idx" ON "Expense"("supplierId")`,

  // ExpenseBudget table
  `CREATE TABLE IF NOT EXISTS "ExpenseBudget" (
    "id" SERIAL NOT NULL,
    "branchId" INTEGER,
    "category" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'MONTHLY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ExpenseBudget_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ExpenseBudget_branchId_category_key"
    ON "ExpenseBudget"("branchId", "category")`,

  // RecurringExpense table
  `CREATE TABLE IF NOT EXISTS "RecurringExpense" (
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
  )`,
  `CREATE INDEX IF NOT EXISTS "RecurringExpense_branchId_active_idx"
    ON "RecurringExpense"("branchId", "active")`,
];

for (const sql of statements) {
  try {
    await client.query(sql);
  } catch (err) {
    console.error('[patch-db] Statement failed:', err.message);
    await client.end();
    process.exit(1);
  }
}

console.log('[patch-db] Done — all expense schema objects ensured.');
await client.end();

-- Hot-path indexes for the transactional models that previously had NONE.
-- These prevent sequential scans on the queries that run on every sale,
-- cash-register close and dashboard load as the tables grow.
-- All idempotent (IF NOT EXISTS): safe to apply on a live DB and reconciles
-- the 3 indexes already created by 20260605130000 (now declared in schema).

-- ── Sale ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Sale_branchId_createdAt_idx"  ON "Sale"("branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "Sale_cashRegisterId_idx"      ON "Sale"("cashRegisterId");
CREATE INDEX IF NOT EXISTS "Sale_userId_idx"              ON "Sale"("userId");
CREATE INDEX IF NOT EXISTS "Sale_customerId_idx"          ON "Sale"("customerId");
CREATE INDEX IF NOT EXISTS "Sale_status_idx"              ON "Sale"("status");

-- ── SaleItem ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "SaleItem_saleId_idx"          ON "SaleItem"("saleId");
CREATE INDEX IF NOT EXISTS "SaleItem_productId_idx"       ON "SaleItem"("productId");

-- ── Payment ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Payment_saleId_idx"           ON "Payment"("saleId");
CREATE INDEX IF NOT EXISTS "Payment_cashRegisterId_idx"   ON "Payment"("cashRegisterId");
CREATE INDEX IF NOT EXISTS "Payment_branchId_createdAt_idx" ON "Payment"("branchId", "createdAt");

-- ── Movement ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Movement_branchId_createdAt_idx" ON "Movement"("branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "Movement_productId_branchId_idx" ON "Movement"("productId", "branchId");

-- ── CashRegister (queried on EVERY sale to find the OPEN shift) ─────────────
CREATE INDEX IF NOT EXISTS "CashRegister_branchId_status_idx" ON "CashRegister"("branchId", "status");
CREATE INDEX IF NOT EXISTS "CashRegister_userId_idx"      ON "CashRegister"("userId");

-- ── Expense ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Expense_branchId_createdAt_idx" ON "Expense"("branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "Expense_cashRegisterId_idx"   ON "Expense"("cashRegisterId");

-- ── Stock (branch-wide inventory reads) ────────────────────────────────────
CREATE INDEX IF NOT EXISTS "Stock_branchId_idx"           ON "Stock"("branchId");

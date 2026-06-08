-- Stock: prevent negative quantity at the database level (safety net).
-- Application-level checks should catch this first, but this constraint
-- prevents any code path from accidentally corrupting stock.
ALTER TABLE "Stock" ADD CONSTRAINT "Stock_quantity_non_negative" CHECK (quantity >= 0);

-- Indexes for common report queries that scan by branch and date range.
-- These prevent full-table scans on Movement and Sale, which grow fast.
CREATE INDEX IF NOT EXISTS "Movement_branchId_createdAt_idx" ON "Movement"("branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "Sale_branchId_createdAt_idx"     ON "Sale"("branchId", "createdAt");
CREATE INDEX IF NOT EXISTS "Sale_customerId_idx"             ON "Sale"("customerId");

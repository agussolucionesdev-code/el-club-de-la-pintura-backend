-- AddColumn: SaleItem.listPrice, SaleItem.discountPct
-- Stores the original list price and the discount % applied per line so that
-- printed tickets can show "Precio $X · desc Y% · paga $Z" transparently.
-- Nullable so all existing sale items remain valid (NULL = no recorded discount).
ALTER TABLE "SaleItem"
  ADD COLUMN IF NOT EXISTS "listPrice"   DECIMAL(14, 4),
  ADD COLUMN IF NOT EXISTS "discountPct" DECIMAL(7, 4);

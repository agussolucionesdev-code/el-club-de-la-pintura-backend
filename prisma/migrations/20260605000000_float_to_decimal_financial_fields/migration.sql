-- Migration: float-to-decimal-financial-fields
-- Applied via prisma db push (migration history was drifted due to raw SQL startup scripts).
-- All financial Float fields migrated to Decimal to eliminate IEEE 754 binary precision errors.

-- Product: financial pricing engine
ALTER TABLE "Product"
  ALTER COLUMN "costPrice"      TYPE DECIMAL(14,4) USING "costPrice"::DECIMAL(14,4),
  ALTER COLUMN "profitMargin"   TYPE DECIMAL(7,4)  USING "profitMargin"::DECIMAL(7,4),
  ALTER COLUMN "ivaPercentage"  TYPE DECIMAL(7,4)  USING "ivaPercentage"::DECIMAL(7,4),
  ALTER COLUMN "retailPrice"    TYPE DECIMAL(14,4) USING "retailPrice"::DECIMAL(14,4),
  ALTER COLUMN "wholesalePrice" TYPE DECIMAL(14,4) USING "wholesalePrice"::DECIMAL(14,4);

-- CashRegister: shift balances
ALTER TABLE "CashRegister"
  ALTER COLUMN "initialBalance"  TYPE DECIMAL(14,2) USING "initialBalance"::DECIMAL(14,2),
  ALTER COLUMN "expectedBalance" TYPE DECIMAL(14,2) USING "expectedBalance"::DECIMAL(14,2),
  ALTER COLUMN "actualBalance"   TYPE DECIMAL(14,2) USING "actualBalance"::DECIMAL(14,2),
  ALTER COLUMN "discrepancy"     TYPE DECIMAL(14,2) USING "discrepancy"::DECIMAL(14,2);

-- Expense: operational costs
ALTER TABLE "Expense"
  ALTER COLUMN "amount" TYPE DECIMAL(14,2) USING "amount"::DECIMAL(14,2);

-- Sale: invoice totals and credit balances
ALTER TABLE "Sale"
  ALTER COLUMN "totalAmount" TYPE DECIMAL(14,2) USING "totalAmount"::DECIMAL(14,2),
  ALTER COLUMN "balance"     TYPE DECIMAL(14,2) USING "balance"::DECIMAL(14,2);

-- SaleItem: line item pricing
ALTER TABLE "SaleItem"
  ALTER COLUMN "unitPrice" TYPE DECIMAL(14,4) USING "unitPrice"::DECIMAL(14,4),
  ALTER COLUMN "subtotal"  TYPE DECIMAL(14,2) USING "subtotal"::DECIMAL(14,2),
  ALTER COLUMN "unitCost"  TYPE DECIMAL(14,4) USING "unitCost"::DECIMAL(14,4);

-- Payment: collected amounts
ALTER TABLE "Payment"
  ALTER COLUMN "amount" TYPE DECIMAL(14,2) USING "amount"::DECIMAL(14,2);

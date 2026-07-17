-- Business-wide settings the owner controls from Configuración.
-- Additive and idempotent: a new table plus the single row it always holds.
CREATE TABLE IF NOT EXISTS "AppSetting" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "discountCodeVisibleToEncargado" BOOLEAN NOT NULL DEFAULT true,
    "alertCashEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertStockEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertStockMinCount" INTEGER NOT NULL DEFAULT 1,
    "alertAccountsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "alertAccountsMinDebt" INTEGER NOT NULL DEFAULT 0,
    "alertPayrollEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- Seed the single row. ON CONFLICT keeps an existing configuration untouched.
INSERT INTO "AppSetting" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

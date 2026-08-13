-- FASE 3 · PASO 3 (BACKFILL): una terminal legado por sucursal.
--
-- Corre DESPUÉS de desplegar el código que hace dual-write, así que lo que
-- entre mientras esto corre ya nace con su terminal. Acá sólo se completa lo
-- viejo: por eso todos los UPDATE filtran por `IS NULL` y la migración es
-- idempotente — re-ejecutarla no toca nada que ya esté hecho.
--
-- No se inventan hechos: la terminal legado se llama así, y las filas que
-- apunten a ella quedan marcadas como atribución inferida, no observada.

-- 1. Una terminal por sucursal, sólo si esa sucursal todavía no tiene ninguna.
INSERT INTO "Terminal" ("code", "name", "branchId", "status", "createdAt", "updatedAt")
SELECT
  'LEGACY-' || b."id",
  'Caja principal',
  b."id",
  'ACTIVE',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Branch" b
WHERE NOT EXISTS (SELECT 1 FROM "Terminal" t WHERE t."branchId" = b."id");

-- 2. Turnos históricos → la terminal legado de SU sucursal.
UPDATE "CashRegister" cr
SET "terminalId" = t."id"
FROM "Terminal" t
WHERE t."branchId" = cr."branchId"
  AND t."code" = 'LEGACY-' || cr."branchId"
  AND cr."terminalId" IS NULL;

-- 3. Ventas históricas → ídem.
UPDATE "Sale" s
SET "terminalId" = t."id"
FROM "Terminal" t
WHERE t."branchId" = s."branchId"
  AND t."code" = 'LEGACY-' || s."branchId"
  AND s."terminalId" IS NULL;

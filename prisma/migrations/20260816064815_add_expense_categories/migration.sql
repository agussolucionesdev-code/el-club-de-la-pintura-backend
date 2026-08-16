-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#64748b',
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_key_key" ON "ExpenseCategory"("key");

-- CreateIndex
CREATE INDEX "ExpenseCategory_isActive_sortOrder_idx" ON "ExpenseCategory"("isActive", "sortOrder");

-- ── Las seis que vinieron con el sistema ────────────────────────────────────
-- Se siembran con la MISMA clave y el MISMO color que tenía cableados el
-- frontend, así nada cambia de aspecto al desplegar.
INSERT INTO "ExpenseCategory" ("key", "label", "color", "isSystem", "isActive", "sortOrder", "createdAt", "updatedAt")
VALUES
  ('SUPPLIER_PAYMENT', 'Pago a proveedor',    '#8b5cf6', true, true, 10, NOW(), NOW()),
  ('UTILITIES',        'Servicios e impuestos','#0ea5e9', true, true, 20, NOW(), NOW()),
  ('SALARY',           'Sueldos',              '#10b981', true, true, 30, NOW(), NOW()),
  ('LOGISTICS',        'Fletes y logística',   '#f59e0b', true, true, 40, NOW(), NOW()),
  ('MAINTENANCE',      'Mantenimiento',        '#f43f5e', true, true, 50, NOW(), NOW()),
  ('OTHER',            'Varios',               '#64748b', true, true, 999, NOW(), NOW())
ON CONFLICT ("key") DO NOTHING;

-- ── Backfill: las categorías que YA existen en los datos ────────────────────
-- `Expense.category` es texto libre y hay valores cargados por scripts y por el
-- seed que no están entre los seis de arriba ("LIMPIEZA", "ALQUILER"...).
--
-- Si no se registran acá, esos gastos históricos quedan sin etiqueta y en gris
-- para siempre: la pantalla mostraría la clave cruda al usuario. Se dan de alta
-- INACTIVAS —no se pueden elegir para un gasto nuevo— pero siguen nombrando y
-- coloreando el pasado, que es exactamente lo que hace falta.
INSERT INTO "ExpenseCategory" ("key", "label", "color", "isSystem", "isActive", "sortOrder", "createdAt", "updatedAt")
SELECT DISTINCT
  e."category",
  -- Etiqueta legible desde la clave: "LIMPIEZA" → "Limpieza".
  UPPER(LEFT(e."category", 1)) || LOWER(SUBSTRING(e."category" FROM 2)),
  '#64748b',
  false,
  false,
  500,
  NOW(),
  NOW()
FROM "Expense" e
WHERE e."category" IS NOT NULL
  AND e."category" <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "ExpenseCategory" c WHERE c."key" = e."category"
  );

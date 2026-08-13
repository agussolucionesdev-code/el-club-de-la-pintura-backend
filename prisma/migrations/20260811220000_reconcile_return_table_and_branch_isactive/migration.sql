-- MIGRACIÓN DE RECONCILIACIÓN
--
-- Cierra una deriva histórica entre `schema.prisma` y el historial de
-- migraciones. Estos objetos EXISTEN en producción —se crearon en su momento
-- con `prisma db push`, que sincroniza el esquema salteándose los archivos de
-- migración— pero nunca quedaron escritos en ninguna migración.
--
-- Consecuencia que esto arregla: una base creada desde cero con
-- `prisma migrate deploy` quedaba SIN la tabla `Return`, o sea con el módulo de
-- devoluciones roto, y sin `Branch.isActive`. Se detectó al levantar la base de
-- tests: 17 de 18 suites fallaban con
-- «The column `isActive` does not exist in the current database».
--
-- Todo es aditivo e idempotente. Sobre una base que ya tiene estos objetos
-- (producción) no cambia nada; sobre una base nueva los crea.
--
-- ⚠️ EN PRODUCCIÓN: como los objetos ya existen, esta migración debe marcarse
-- como aplicada SIN ejecutarse, con:
--     npx prisma migrate resolve --applied 20260811220000_reconcile_return_table_and_branch_isactive
-- Ejecutarla igual tampoco rompería nada gracias a los IF NOT EXISTS, pero
-- `resolve` deja el historial más honesto: dice "esto ya estaba".

-- Branch.isActive — baja lógica de sucursales.
ALTER TABLE "Branch" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;

-- Return — devoluciones de mercadería contra una venta.
CREATE TABLE IF NOT EXISTS "Return" (
    "id" SERIAL NOT NULL,
    "saleId" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "createdById" INTEGER NOT NULL,
    "totalRefund" DECIMAL(14,2) NOT NULL,
    "items" JSONB NOT NULL,
    "cashRegisterId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Return_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Return_saleId_idx" ON "Return"("saleId");
CREATE INDEX IF NOT EXISTS "Return_branchId_idx" ON "Return"("branchId");

-- La FK no admite IF NOT EXISTS: se agrega sólo si todavía no está.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Return_saleId_fkey'
  ) THEN
    ALTER TABLE "Return"
      ADD CONSTRAINT "Return_saleId_fkey"
      FOREIGN KEY ("saleId") REFERENCES "Sale"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

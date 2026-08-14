-- FASE 5, paso CONTRACT: la atribución pasa a ser OBLIGATORIA.
--
-- ── Por qué recién ahora y no junto al expand ───────────────────────────────
--
-- Entre que corre una migración y arranca el código nuevo hay una ventana —de
-- segundos, pero real— en la que el código VIEJO todavía atiende requests. Si
-- `sellerId` hubiera pasado a NOT NULL en el mismo deploy que lo introdujo, una
-- venta entrada en esa ventana habría fallado con un error de base delante de
-- un cliente.
--
-- Ahora el código que llena estas columnas ya está corriendo en producción
-- (verificado: 41 de 41 ventas con vendedor asignado), así que el paso es
-- seguro. Es el paso 6 de §5.1 del plan, hecho cuando corresponde y no antes.
--
-- ── Se defiende sola ────────────────────────────────────────────────────────
--
-- Si algo quedó sin atribución, esto ABORTA en vez de fallar a mitad de camino
-- con un mensaje de Postgres sobre restricciones. Prisma envuelve cada archivo
-- en una transacción, así que un fallo acá no deja nada aplicado.

DO $$
DECLARE
  sin_vendedor INTEGER;
  sin_cajero   INTEGER;
BEGIN
  SELECT COUNT(*) INTO sin_vendedor FROM "Sale" WHERE "sellerId"  IS NULL;
  SELECT COUNT(*) INTO sin_cajero   FROM "Sale" WHERE "cashierId" IS NULL;

  IF sin_vendedor > 0 OR sin_cajero > 0 THEN
    RAISE EXCEPTION
      'No se puede exigir atribución: hay % ventas sin vendedor y % sin cajero. '
      'Corré de nuevo el backfill (20260813140100) antes de este paso.',
      sin_vendedor, sin_cajero;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Sale"
  ALTER COLUMN "sellerId"  SET NOT NULL,
  ALTER COLUMN "cashierId" SET NOT NULL;

-- ⚠️ VUELTA ATRÁS
--
-- Éste es el único paso de la Fase 5 con rollback real, porque es el único que
-- restringe en vez de agregar. Para deshacerlo:
--
--   ALTER TABLE "Sale"
--     ALTER COLUMN "sellerId"  DROP NOT NULL,
--     ALTER COLUMN "cashierId" DROP NOT NULL;
--
-- No borra ni un dato: sólo vuelve a admitir filas sin atribución.

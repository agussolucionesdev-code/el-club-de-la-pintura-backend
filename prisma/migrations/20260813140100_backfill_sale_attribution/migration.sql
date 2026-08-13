-- FASE 5, paso BACKFILL: darle atribución a las ventas históricas.
--
-- ── La regla que ordena este archivo: no inventar hechos ────────────────────
--
-- De las ventas viejas sabemos UNA sola cosa: qué usuario tenía la sesión
-- abierta (`userId`). No sabemos quién vendió ni quién cobró — nadie lo
-- registró nunca, porque el campo no existía.
--
-- Copiar `userId` a vendedor y cajero es la mejor aproximación disponible, y
-- para casi todas las ventas va a ser correcta (un solo puesto por local). Pero
-- **es una suposición, no un dato observado**, y presentarla como si fuera lo
-- segundo sería exactamente la clase de mentira que este proyecto viene
-- corrigiendo: la comisión de alguien no puede apoyarse en una inferencia
-- silenciosa.
--
-- Por eso cada fila tocada acá queda con `attributionLegacy = true`. El
-- historial la muestra marcada y los incentivos de la Fase 8 la van a poder
-- excluir o reportar aparte, con el monto a la vista.
--
-- ── Idempotente y reanudable ────────────────────────────────────────────────
--
-- Filtra por `IS NULL`, así que re-ejecutarlo no toca lo ya migrado ni pisa lo
-- que el código nuevo haya escrito mientras tanto.

-- ── 1. Vendedor y cajero: el único usuario que la venta conoce ──
UPDATE "Sale" s
SET "sellerId"  = s."userId",
    "cashierId" = s."userId",
    "attributionLegacy" = true
WHERE s."sellerId" IS NULL;

-- ── 2. Nombres congelados ──
-- Se toman del usuario ACTUAL porque es lo único que hay. Van marcados como
-- inferidos igual que el resto: si a esa persona la renombraron desde entonces,
-- el snapshot dice el nombre de hoy, no el de la venta.
UPDATE "Sale" s
SET "sellerNameSnapshot"  = u."name",
    "cashierNameSnapshot" = u."name"
FROM "User" u
WHERE u."id" = s."sellerId"
  AND s."sellerNameSnapshot" IS NULL;

-- ── 3. Consumo interno ──
-- Hoy el consumo del personal es una venta ordinaria a un `Customer` de tipo
-- INTERNAL. Eso lo mete en la facturación y en el ranking de vendedores como si
-- fuera venta a un cliente real. Marcarlo permite sacarlo de los reportes ya,
-- sin esperar al modelo completo de la Fase 7 — y sin borrar ni migrar nada:
-- la venta sigue existiendo igual, sólo que ahora dice lo que es.
UPDATE "Sale" s
SET "kind" = 'INTERNAL_CONSUMPTION'
FROM "Customer" c
WHERE c."id" = s."customerId"
  AND c."type" = 'INTERNAL'
  AND s."kind" = 'SALE';

-- ── 4. Verificación dentro de la misma transacción ──
-- Si algo no cerró, la migración ABORTA y no deja nada a medias. Prisma envuelve
-- cada archivo en una transacción, así que este DO es la última barrera.
DO $$
DECLARE
  sin_vendedor INTEGER;
  sin_cajero   INTEGER;
  incoherentes INTEGER;
BEGIN
  SELECT COUNT(*) INTO sin_vendedor FROM "Sale" WHERE "sellerId"  IS NULL;
  SELECT COUNT(*) INTO sin_cajero   FROM "Sale" WHERE "cashierId" IS NULL;

  -- Ninguna venta puede quedar atribuida a un usuario que no existe.
  SELECT COUNT(*) INTO incoherentes
  FROM "Sale" s
  LEFT JOIN "User" us ON us."id" = s."sellerId"
  LEFT JOIN "User" uc ON uc."id" = s."cashierId"
  WHERE us."id" IS NULL OR uc."id" IS NULL;

  IF sin_vendedor > 0 OR sin_cajero > 0 THEN
    RAISE EXCEPTION
      'Backfill incompleto: % ventas sin vendedor y % sin cajero.',
      sin_vendedor, sin_cajero;
  END IF;

  IF incoherentes > 0 THEN
    RAISE EXCEPTION
      'Hay % ventas atribuidas a un usuario inexistente. Se aborta.',
      incoherentes;
  END IF;
END $$;

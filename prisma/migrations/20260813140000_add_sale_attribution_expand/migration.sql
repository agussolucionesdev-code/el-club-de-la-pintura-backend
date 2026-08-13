-- FASE 5, paso EXPAND: atribución de la venta.
--
-- Aditiva pura: siete columnas nullable (o con default) y cinco índices. Ni una
-- fila existente cambia de forma, y el código desplegado hoy las ignora.
--
-- ── Qué problema abre esto ──────────────────────────────────────────────────
--
-- Hasta ahora `Sale` tenía UN campo de usuario, llenado con el dueño del token.
-- Con eso no se puede responder ninguna de las dos preguntas que importan:
-- quién VENDIÓ (define la comisión) y quién COBRÓ (define de quién es el
-- faltante en el arqueo). En un mostrador compartido son personas distintas.
--
-- ── Por qué índices normales y no CONCURRENTLY ──────────────────────────────
--
-- La regla de §4.9 elige por TAMAÑO MEDIDO. Medido en producción:
--
--     SELECT COUNT(*) FROM "Sale";   -->  41
--
-- Cuarenta y una filas. Un índice tarda milisegundos y el lock es irrelevante.
-- `CONCURRENTLY` además está PROHIBIDO dentro del bloque transaccional que
-- Prisma abre por migración (error 25001): habría fallado al aplicarse.
--
-- ── Lo que este archivo NO hace ─────────────────────────────────────────────
--
-- No pone nada en NOT NULL. El paso de CONTRACT va en una migración aparte, y
-- sólo después de que el código que llena estas columnas esté desplegado. Entre
-- migrar y desplegar hay una ventana —corta, pero real— en la que el código
-- viejo podría insertar una venta sin estos campos. Ver §5.1, paso 6.

-- AlterTable
ALTER TABLE "Sale"
  ADD COLUMN "sellerId"            INTEGER,
  ADD COLUMN "cashierId"           INTEGER,
  ADD COLUMN "operatorSessionId"   INTEGER,
  ADD COLUMN "sellerNameSnapshot"  TEXT,
  ADD COLUMN "cashierNameSnapshot" TEXT,
  ADD COLUMN "attributionLegacy"   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "kind"                TEXT    NOT NULL DEFAULT 'SALE';

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_sellerId_fkey"
  FOREIGN KEY ("sellerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_cashierId_fkey"
  FOREIGN KEY ("cashierId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Sale_sellerId_createdAt_idx"   ON "Sale"("sellerId", "createdAt");
CREATE INDEX "Sale_cashierId_createdAt_idx"  ON "Sale"("cashierId", "createdAt");
CREATE INDEX "Sale_terminalId_createdAt_idx" ON "Sale"("terminalId", "createdAt");
CREATE INDEX "Sale_kind_createdAt_idx"       ON "Sale"("kind", "createdAt");
CREATE INDEX "Sale_createdAt_idx"            ON "Sale"("createdAt");

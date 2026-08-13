-- FASE 4 (segunda parte): borradores del POS, origen de la sesión y los dos
-- índices parciales que hacen cumplir los invariantes.
--
-- Aditiva pura: una tabla y dos enums nuevos, más una columna con DEFAULT.
--
-- ── Por qué los índices van acá y no en schema.prisma ──────────────────────
--
-- Prisma no sabe expresar índices únicos PARCIALES (con WHERE). La restricción
-- tiene que vivir en la BASE y no en el código: un `findFirst` seguido de un
-- `create` deja una ventana entre los dos, y dos cajeros que aprietan a la vez
-- se cuelan por el medio. El índice no tiene ventana.
--
-- Prisma IGNORA los índices que no declara, así que `migrate diff` sigue
-- limpio: no los ve como deriva.
--
-- ⚠️ NADA de CREATE INDEX CONCURRENTLY acá: PostgreSQL lo prohíbe dentro de un
-- bloque transaccional (error 25001) y Prisma envuelve cada migración en una
-- transacción. Fallaría al aplicarse. Y no hace falta: son tablas recién
-- creadas, con cero filas.

-- CreateEnum
CREATE TYPE "PosSessionOrigin" AS ENUM ('PIN', 'LEGACY_JWT');

-- CreateEnum
CREATE TYPE "PosDraftKind" AS ENUM ('DRAFT', 'HELD');

-- AlterTable: cómo se probó la identidad del operador.
-- DEFAULT 'PIN' es correcto para las filas existentes porque no hay ninguna:
-- la tabla se creó en la migración anterior y todavía no operó nadie.
ALTER TABLE "PosOperatorSession"
  ADD COLUMN "origin" "PosSessionOrigin" NOT NULL DEFAULT 'PIN';

-- CreateTable
CREATE TABLE "PosDraft" (
    "id" SERIAL NOT NULL,
    "terminalId" INTEGER NOT NULL,
    "operatorUserId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "kind" "PosDraftKind" NOT NULL DEFAULT 'DRAFT',
    "label" TEXT,
    "payload" JSONB NOT NULL,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PosDraft_terminalId_operatorUserId_kind_idx"
  ON "PosDraft"("terminalId", "operatorUserId", "kind");

-- CreateIndex
CREATE INDEX "PosDraft_updatedAt_idx" ON "PosDraft"("updatedAt");

-- AddForeignKey
ALTER TABLE "PosDraft" ADD CONSTRAINT "PosDraft_terminalId_fkey"
  FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosDraft" ADD CONSTRAINT "PosDraft_operatorUserId_fkey"
  FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ══════════════════════════════════════════════════════════════════════════
-- INVARIANTES IMPUESTOS POR LA BASE
-- ══════════════════════════════════════════════════════════════════════════

-- Una terminal, UN operador activo.
-- Si hubiera dos, la venta que entra ahora no se sabría a quién atribuir — y de
-- la atribución dependen la comisión y el arqueo.
CREATE UNIQUE INDEX "pos_operator_session_one_active_per_terminal"
  ON "PosOperatorSession"("terminalId")
  WHERE status = 'ACTIVE';

-- Un carrito en curso por operador y terminal.
-- Los tickets EN ESPERA (kind='HELD') no entran: de esos puede haber varios,
-- que es justo para lo que sirve F7.
CREATE UNIQUE INDEX "pos_draft_one_current_per_operator"
  ON "PosDraft"("terminalId", "operatorUserId")
  WHERE kind = 'DRAFT';

-- Idempotencia de operaciones económicas.
--
-- Cierra P0-2: `POST /sales` no tenía NINGUNA protección contra duplicados.
-- Sólo la cola offline llevaba clave; en el camino online, un reintento de red
-- —o un timeout del que el cliente no se entera— creaba una segunda venta con
-- su propio descuento de stock y su propio cobro.
--
-- Aditiva pura: tabla nueva, enum nuevo y una columna nullable en `Sale`.
-- Ninguna fila existente cambia, ningún camino actual se rompe.

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('IN_FLIGHT', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "scopeVersion" INTEGER NOT NULL,
    "scopeHash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL,
    "attemptId" TEXT NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "resultType" TEXT,
    "resultId" TEXT,
    "httpStatus" INTEGER,
    "failureCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_status_lockedUntil_idx" ON "IdempotencyRecord"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_idempotencyKey_key" ON "Sale"("idempotencyKey");


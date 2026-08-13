-- FASE 3 · PASO 1 (EXPAND): terminales físicas.
--
-- Aditiva PURA: tablas y enum nuevos, más dos columnas NULLABLE en
-- `CashRegister` y `Sale`. Ninguna fila existente cambia y ningún camino actual
-- se rompe: el código desplegado hoy ignora estas columnas.
--
-- El backfill va en una migración APARTE (paso 3) a propósito. Entre medio se
-- despliega el código que hace dual-write, así que cualquier venta o turno que
-- entre MIENTRAS corre el backfill nace ya con su terminal. Fusionar los dos
-- pasos dejaría un hueco por el que se colarían filas sin terminal.

-- CreateEnum
CREATE TYPE "TerminalStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "CashRegister" ADD COLUMN     "terminalId" INTEGER;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "terminalId" INTEGER;

-- CreateTable
CREATE TABLE "Terminal" (
    "id" SERIAL NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "branchId" INTEGER NOT NULL,
    "status" "TerminalStatus" NOT NULL DEFAULT 'ACTIVE',
    "deviceSecretHash" TEXT,
    "deviceSecretVersion" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Terminal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TerminalEnrollment" (
    "id" SERIAL NOT NULL,
    "terminalId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "issuedById" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TerminalEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Terminal_code_key" ON "Terminal"("code");

-- CreateIndex
CREATE INDEX "Terminal_branchId_status_idx" ON "Terminal"("branchId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TerminalEnrollment_tokenHash_key" ON "TerminalEnrollment"("tokenHash");

-- CreateIndex
CREATE INDEX "TerminalEnrollment_terminalId_idx" ON "TerminalEnrollment"("terminalId");

-- AddForeignKey
ALTER TABLE "CashRegister" ADD CONSTRAINT "CashRegister_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Terminal" ADD CONSTRAINT "Terminal_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TerminalEnrollment" ADD CONSTRAINT "TerminalEnrollment_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


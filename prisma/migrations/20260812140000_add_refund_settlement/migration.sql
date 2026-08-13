-- Liquidación de reintegros: cómo se le devuelve la plata al cliente.
--
-- Antes, una devolución de venta YA PAGADA restauraba stock y no registraba
-- ningún movimiento de dinero. El cajón esperaba más efectivo del que tenía y
-- al cerrar el turno aparecía una diferencia inexplicable.
--
-- No alcanzaba con "crear siempre un Payment negativo": sería igual de falso al
-- revés. Una devolución contra deuda impaga no saca un peso del cajón, y una
-- reversa de tarjeta ocurre en el Posnet, fuera de este sistema.
--
-- Aditiva pura: enum y tabla nuevos. Ninguna fila existente cambia.

-- CreateEnum
CREATE TYPE "RefundSettlementKind" AS ENUM ('CASH', 'TRANSFER', 'CARD_REVERSAL', 'CUSTOMER_DEBT_CREDIT', 'STAFF_LEDGER_CREDIT', 'PENDING_REIMBURSEMENT');

-- CreateTable
CREATE TABLE "RefundSettlement" (
    "id" SERIAL NOT NULL,
    "returnId" INTEGER NOT NULL,
    "kind" "RefundSettlementKind" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "cashRegisterId" INTEGER,
    "paymentId" INTEGER,
    "reference" TEXT,
    "createdById" INTEGER NOT NULL,
    "authorizedById" INTEGER,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefundSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RefundSettlement_returnId_idx" ON "RefundSettlement"("returnId");

-- CreateIndex
CREATE INDEX "RefundSettlement_kind_idx" ON "RefundSettlement"("kind");

-- AddForeignKey
ALTER TABLE "RefundSettlement" ADD CONSTRAINT "RefundSettlement_returnId_fkey" FOREIGN KEY ("returnId") REFERENCES "Return"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


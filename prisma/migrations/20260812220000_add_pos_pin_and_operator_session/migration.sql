-- FASE 4: PIN del punto de venta y sesión de operador.
--
-- Aditiva pura: tres tablas y dos enums nuevos. Nada existente cambia.
--
-- ⚠️ VARIABLES DE ENTORNO OBLIGATORIAS antes de desplegar el código:
--
--   POS_PIN_PEPPER            secreto para Argon2id, mínimo 16 caracteres
--   POS_PIN_ENC_KEY           clave AES-256 (32 bytes en hex o base64)
--   POS_PIN_ENC_KEY_VERSION   opcional, por defecto 1
--
-- Tienen que ser DISTINTAS entre sí y distintas de JWT_SECRET: compartirlas
-- haría que una sola filtración diera verificación y revelado a la vez.
--
-- Sin POS_PIN_ENC_KEY el sistema entra en modo degradado: se puede seguir
-- VALIDANDO el PIN (usa el hash) pero no revelarlo, crearlo ni cambiarlo.

-- CreateEnum
CREATE TYPE "PosSessionStatus" AS ENUM ('ACTIVE', 'LOCKED', 'CLOSED');

-- CreateTable
CREATE TABLE "PosPinCredential" (
    "userId" INTEGER NOT NULL,
    "pinHash" TEXT NOT NULL,
    "pinCipher" BYTEA,
    "pinNonce" BYTEA,
    "pinTag" BYTEA,
    "keyVersion" INTEGER,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "mustChange" BOOLEAN NOT NULL DEFAULT false,
    "lastChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastRevealAt" TIMESTAMP(3),
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosPinCredential_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PosPinActivation" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "codeHash" TEXT NOT NULL,
    "issuedById" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosPinActivation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PosOperatorSession" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "terminalId" INTEGER NOT NULL,
    "branchId" INTEGER NOT NULL,
    "cashRegisterId" INTEGER,
    "status" "PosSessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "authenticatedActorId" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "PosOperatorSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosPinActivation_codeHash_key" ON "PosPinActivation"("codeHash");

-- CreateIndex
CREATE INDEX "PosPinActivation_userId_idx" ON "PosPinActivation"("userId");

-- CreateIndex
CREATE INDEX "PosOperatorSession_terminalId_status_idx" ON "PosOperatorSession"("terminalId", "status");

-- CreateIndex
CREATE INDEX "PosOperatorSession_userId_status_idx" ON "PosOperatorSession"("userId", "status");

-- AddForeignKey
ALTER TABLE "PosPinCredential" ADD CONSTRAINT "PosPinCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosPinActivation" ADD CONSTRAINT "PosPinActivation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOperatorSession" ADD CONSTRAINT "PosOperatorSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PosOperatorSession" ADD CONSTRAINT "PosOperatorSession_terminalId_fkey" FOREIGN KEY ("terminalId") REFERENCES "Terminal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


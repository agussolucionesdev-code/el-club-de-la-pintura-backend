-- AlterTable
ALTER TABLE "SyncOperation" ADD COLUMN     "attributionConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "attributionConfirmedById" INTEGER;

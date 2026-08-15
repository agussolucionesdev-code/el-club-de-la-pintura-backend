-- AlterTable
ALTER TABLE "SyncOperation" ADD COLUMN     "attributionUnverified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "leaseToken" TEXT,
ADD COLUMN     "sequence" INTEGER,
ADD COLUMN     "syncDecisionReason" TEXT;

-- AlterTable
ALTER TABLE "Terminal" ADD COLUMN     "lastOfflineSequence" INTEGER NOT NULL DEFAULT 0;

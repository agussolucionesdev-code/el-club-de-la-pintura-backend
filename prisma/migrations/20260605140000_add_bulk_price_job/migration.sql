-- CreateTable: BulkPriceJob
-- Stores bulk price update job state in DB so it survives server restarts.
-- Previously only stored in-memory (Map<string, JobState>).
CREATE TABLE "BulkPriceJob" (
    "id"           TEXT          NOT NULL,
    "userId"       INTEGER       NOT NULL,
    "filename"     TEXT          NOT NULL,
    "status"       TEXT          NOT NULL DEFAULT 'PENDING',
    "processed"    INTEGER       NOT NULL DEFAULT 0,
    "total"        INTEGER       NOT NULL DEFAULT 0,
    "successCount" INTEGER       NOT NULL DEFAULT 0,
    "errorCount"   INTEGER       NOT NULL DEFAULT 0,
    "errors"       JSONB,
    "createdAt"    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3)  NOT NULL,
    "finishedAt"   TIMESTAMP(3),

    CONSTRAINT "BulkPriceJob_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BulkPriceJob_userId_idx" ON "BulkPriceJob"("userId");
CREATE INDEX "BulkPriceJob_status_idx" ON "BulkPriceJob"("status");

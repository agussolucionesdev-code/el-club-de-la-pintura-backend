/**
 * Bulk Price Update Controller — async streaming-based price updates.
 *
 * Accepts CSV or Excel uploads and processes them in batches of 50 without
 * buffering the full file in memory. This prevents OOM crashes on small Node
 * instances (e.g., Render free tier, 512 MB RAM).
 *
 * CSV format (header required):  sku, newRetailPrice [, newWholesalePrice]
 * Excel format: same columns in the first worksheet, row 1 = header.
 *
 * Job progress is persisted in the BulkPriceJob table so state survives
 * server restarts. Previously stored only in an in-memory Map.
 */
import fs from "fs";
import path from "path";
import { Response } from "express";
import { parse } from "csv-parse";
import ExcelJS from "exceljs";
import { randomUUID } from "crypto";
import { logger } from "../../config/logger";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

const BATCH_SIZE = 50;
// Cap stored error list to avoid unbounded JSON growth in the DB
const MAX_STORED_ERRORS = 200;

// ── Helpers ───────────────────────────────────────────────────────────────────

interface PriceRow {
  sku: string;
  newRetailPrice: number;
  newWholesalePrice?: number;
}

interface RowError {
  row?: number;
  sku: string;
  message: string;
}

const parseRow = (row: Record<string, string>): PriceRow | null => {
  const sku = (row["sku"] ?? row["SKU"] ?? "").toString().trim();
  const retail = parseFloat(
    (row["newRetailPrice"] ?? row["retailPrice"] ?? row["precio"] ?? "").toString(),
  );

  if (!sku || !Number.isFinite(retail) || retail < 0) return null;

  const wholesale = parseFloat(
    (row["newWholesalePrice"] ?? row["wholesalePrice"] ?? row["mayorista"] ?? "").toString(),
  );

  return {
    sku,
    newRetailPrice: Math.round(retail * 10000) / 10000,
    newWholesalePrice: Number.isFinite(wholesale) && wholesale >= 0 ? wholesale : undefined,
  };
};

const applyBatch = async (batch: PriceRow[], rowErrors: RowError[]) => {
  await Promise.all(
    batch.map(async (row) => {
      try {
        const data: { retailPrice: number; wholesalePrice?: number | null } = {
          retailPrice: row.newRetailPrice,
        };
        if (row.newWholesalePrice !== undefined) {
          data.wholesalePrice = row.newWholesalePrice;
        }
        const updated = await prisma.product.updateMany({
          where: { sku: row.sku, isActive: true },
          data,
        });
        if (updated.count === 0) {
          rowErrors.push({ sku: row.sku, message: `SKU no encontrado o inactivo: ${row.sku}` });
        }
      } catch (err) {
        rowErrors.push({
          sku: row.sku,
          message: `Error en SKU ${row.sku}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }),
  );
};

// ── DB state helpers ──────────────────────────────────────────────────────────

const persistJobProgress = async (
  jobId: string,
  processed: number,
  successCount: number,
  errors: RowError[],
) => {
  try {
    await prisma.bulkPriceJob.update({
      where: { id: jobId },
      data: {
        processed,
        successCount,
        errorCount: errors.length,
        errors: errors.slice(0, MAX_STORED_ERRORS) as object[],
      },
    });
  } catch {
    // Non-fatal — logging is enough
  }
};

const finalizeJob = async (jobId: string, status: "DONE" | "ERROR", processed: number, successCount: number, errors: RowError[]) => {
  await prisma.bulkPriceJob.update({
    where: { id: jobId },
    data: {
      status,
      processed,
      successCount,
      errorCount: errors.length,
      errors: errors.slice(0, MAX_STORED_ERRORS) as object[],
      finishedAt: new Date(),
    },
  });
};

// ── CSV streaming processor ────────────────────────────────────────────────────

const processCsvStream = async (filePath: string, jobId: string) => {
  const stream = fs.createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true }),
  );

  let batch: PriceRow[] = [];
  let processed = 0;
  let successCount = 0;
  const rowErrors: RowError[] = [];

  for await (const rawRow of stream) {
    const row = parseRow(rawRow as Record<string, string>);
    if (!row) continue;

    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      const prevErrors = rowErrors.length;
      await applyBatch(batch, rowErrors);
      processed += batch.length;
      successCount += batch.length - (rowErrors.length - prevErrors);
      await persistJobProgress(jobId, processed, successCount, rowErrors);
      batch = [];
    }
  }

  if (batch.length > 0) {
    const prevErrors = rowErrors.length;
    await applyBatch(batch, rowErrors);
    processed += batch.length;
    successCount += batch.length - (rowErrors.length - prevErrors);
  }

  return { processed, successCount, rowErrors };
};

// ── Excel streaming processor ──────────────────────────────────────────────────

const processExcelStream = async (filePath: string, jobId: string) => {
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {});

  let batch: PriceRow[] = [];
  let headerMap: Record<number, string> = {};
  let isFirstRow = true;
  let processed = 0;
  let successCount = 0;
  const rowErrors: RowError[] = [];

  for await (const worksheet of workbookReader) {
    for await (const row of worksheet) {
      const rowData = row.values as (string | number | null | undefined)[];
      if (isFirstRow) {
        rowData.forEach((val, idx) => {
          if (val != null) headerMap[idx] = String(val).trim();
        });
        isFirstRow = false;
        continue;
      }

      const rawRow: Record<string, string> = {};
      rowData.forEach((val, idx) => {
        const header = headerMap[idx];
        if (header) rawRow[header] = val != null ? String(val) : "";
      });

      const parsedRow = parseRow(rawRow);
      if (!parsedRow) continue;

      batch.push(parsedRow);
      if (batch.length >= BATCH_SIZE) {
        const prevErrors = rowErrors.length;
        await applyBatch(batch, rowErrors);
        processed += batch.length;
        successCount += batch.length - (rowErrors.length - prevErrors);
        await persistJobProgress(jobId, processed, successCount, rowErrors);
        batch = [];
      }
    }
    break; // Only first worksheet
  }

  if (batch.length > 0) {
    const prevErrors = rowErrors.length;
    await applyBatch(batch, rowErrors);
    processed += batch.length;
    successCount += batch.length - (rowErrors.length - prevErrors);
  }

  return { processed, successCount, rowErrors };
};

// ── Controller exports ─────────────────────────────────────────────────────────

/**
 * POST /products/bulk-price-update
 *
 * Accepts a multipart CSV or Excel file. Validates headers, creates a
 * persistent BulkPriceJob record, launches the streaming job asynchronously,
 * and immediately returns the job ID for polling.
 */
export const startBulkPriceUpdate = async (req: AuthRequest, res: Response) => {
  try {
    const authUser = getAuthUser(req);
    if (!authUser) return res.status(401).json({ error: "No autenticado." });

    if (!req.file) {
      return res.status(400).json({ error: "Adjuntá un archivo CSV o Excel (.csv, .xlsx)." });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    if (ext !== ".csv" && ext !== ".xlsx") {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "Solo se aceptan archivos .csv o .xlsx." });
    }

    // Create persistent job record before starting background work
    const jobId = randomUUID();
    await prisma.bulkPriceJob.create({
      data: {
        id: jobId,
        userId: authUser.id,
        filename: req.file.originalname,
        status: "PROCESSING",
      },
    });

    const filePath = req.file.path;

    // Fire-and-forget: process in background, clean up file when done
    (async () => {
      try {
        const result = ext === ".csv"
          ? await processCsvStream(filePath, jobId)
          : await processExcelStream(filePath, jobId);

        await finalizeJob(jobId, "DONE", result.processed, result.successCount, result.rowErrors);
        logger.info(`Bulk price job ${jobId} done: ${result.processed} processed, ${result.rowErrors.length} errors`);
      } catch (err) {
        logger.error(`Bulk price job ${jobId} failed:`, err);
        try {
          await prisma.bulkPriceJob.update({
            where: { id: jobId },
            data: {
              status: "ERROR",
              finishedAt: new Date(),
              errors: [{ message: err instanceof Error ? err.message : String(err) }],
            },
          });
        } catch { /* ignore update error */ }
      } finally {
        fs.unlink(filePath, () => {});
      }
    })();

    res.status(202).json({
      message: "Actualización masiva iniciada.",
      jobId,
    });
  } catch (error) {
    logger.error("Error al iniciar bulk price update:", error);
    res.status(500).json({ error: "Error al iniciar la actualización masiva." });
  }
};

/**
 * GET /products/bulk-price-update/:jobId
 *
 * Returns the current progress of a running or completed job from the DB.
 * Safe across server restarts.
 */
export const getBulkPriceUpdateStatus = async (req: AuthRequest, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) return res.status(401).json({ error: "No autenticado." });

  const jobId = String(req.params.jobId ?? "");
  const job = await prisma.bulkPriceJob.findUnique({ where: { id: jobId } });

  if (!job) {
    return res.status(404).json({ error: "Job no encontrado o expirado." });
  }

  const errors = Array.isArray(job.errors) ? (job.errors as unknown) as RowError[] : [];

  res.status(200).json({
    jobId: job.id,
    status: job.status.toLowerCase(),
    processed: job.processed,
    successCount: job.successCount,
    errorCount: job.errorCount,
    errors: errors.slice(0, 20),
    filename: job.filename,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt ?? null,
  });
};

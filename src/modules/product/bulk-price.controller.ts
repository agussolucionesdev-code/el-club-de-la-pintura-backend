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
 * Job progress is tracked in an in-memory Map. For multi-instance deployments
 * replace with Redis; the interface stays identical.
 */
import fs from "fs";
import path from "path";
import { Response } from "express";
import { parse } from "csv-parse";
import ExcelJS from "exceljs";
import { logger } from "../../config/logger";
import prisma from "../../config/db";
import { AuthRequest, getAuthUser } from "../../middlewares/auth.middleware";

// ── Job state ─────────────────────────────────────────────────────────────────

type JobStatus = "running" | "done" | "error";

interface JobState {
  status: JobStatus;
  processed: number;
  errors: string[];
  startedAt: Date;
  finishedAt?: Date;
}

const jobs = new Map<string, JobState>();

const BATCH_SIZE = 50;

// ── Helpers ───────────────────────────────────────────────────────────────────

interface PriceRow {
  sku: string;
  newRetailPrice: number;
  newWholesalePrice?: number;
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

const applyBatch = async (batch: PriceRow[], jobErrors: string[]) => {
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
          jobErrors.push(`SKU no encontrado o inactivo: ${row.sku}`);
        }
      } catch (err) {
        jobErrors.push(`Error en SKU ${row.sku}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );
};

// ── CSV streaming processor ────────────────────────────────────────────────────

const processCsvStream = async (filePath: string, jobId: string) => {
  const job = jobs.get(jobId)!;
  const stream = fs.createReadStream(filePath).pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true }),
  );

  let batch: PriceRow[] = [];

  for await (const rawRow of stream) {
    const row = parseRow(rawRow as Record<string, string>);
    if (!row) continue;

    batch.push(row);
    if (batch.length >= BATCH_SIZE) {
      await applyBatch(batch, job.errors);
      job.processed += batch.length;
      batch = [];
    }
  }

  if (batch.length > 0) {
    await applyBatch(batch, job.errors);
    job.processed += batch.length;
  }
};

// ── Excel streaming processor ──────────────────────────────────────────────────

const processExcelStream = async (filePath: string, jobId: string) => {
  const job = jobs.get(jobId)!;
  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {});

  let batch: PriceRow[] = [];
  let headerMap: Record<number, string> = {};
  let isFirstRow = true;

  for await (const worksheet of workbookReader) {
    for await (const row of worksheet) {
      const rowData = row.values as (string | number | null | undefined)[];
      // row.values is 1-indexed
      if (isFirstRow) {
        // Build header map: column index → header name
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
        await applyBatch(batch, job.errors);
        job.processed += batch.length;
        batch = [];
      }
    }
    // Only process the first worksheet
    break;
  }

  if (batch.length > 0) {
    await applyBatch(batch, job.errors);
    job.processed += batch.length;
  }
};

// ── Controller exports ─────────────────────────────────────────────────────────

/**
 * POST /products/bulk-price-update
 *
 * Accepts a multipart CSV or Excel file. Validates headers, launches the
 * streaming job asynchronously, and immediately returns a job ID.
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

    const jobId = `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    jobs.set(jobId, { status: "running", processed: 0, errors: [], startedAt: new Date() });

    const filePath = req.file.path;

    // Fire-and-forget: process in background, clean up file when done
    (async () => {
      try {
        if (ext === ".csv") {
          await processCsvStream(filePath, jobId);
        } else {
          await processExcelStream(filePath, jobId);
        }
        const job = jobs.get(jobId)!;
        job.status = "done";
        job.finishedAt = new Date();
        logger.info(`Bulk price update job ${jobId} completed: ${job.processed} products processed, ${job.errors.length} errors`);
      } catch (err) {
        const job = jobs.get(jobId);
        if (job) {
          job.status = "error";
          job.errors.push(err instanceof Error ? err.message : String(err));
          job.finishedAt = new Date();
        }
        logger.error(`Bulk price update job ${jobId} failed:`, err);
      } finally {
        fs.unlink(filePath, () => {});
        // Expire job state after 30 minutes
        setTimeout(() => jobs.delete(jobId), 30 * 60 * 1000);
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
 * Returns the current progress of a running or completed job.
 */
export const getBulkPriceUpdateStatus = async (req: AuthRequest, res: Response) => {
  const authUser = getAuthUser(req);
  if (!authUser) return res.status(401).json({ error: "No autenticado." });

  const jobId = String(req.params.jobId ?? "");
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job no encontrado o expirado." });
  }

  res.status(200).json({
    jobId,
    status: job.status,
    processed: job.processed,
    errorCount: job.errors.length,
    errors: job.errors.slice(0, 20), // cap to avoid huge responses
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? null,
  });
};

/**
 * One-time migration history reconciliation (deterministic, no prisma CLI).
 *
 * Three migration folders exist in prisma/migrations but were never recorded in
 * the host's `_prisma_migrations` table (their columns already exist in the DB
 * via earlier idempotent boot scripts). This records them as applied by inserting
 * the bookkeeping row directly — with the SAME sha256 checksum Prisma computes
 * from the migration.sql bytes — so `prisma migrate deploy` sees a clean history
 * and validates the checksum without re-running the SQL.
 *
 * Safe: only inserts/normalizes the bookkeeping rows for these 3 specific
 * migrations, never any data and never the already-applied migrations.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import pkg from "pg";

const { Client } = pkg;

const TARGETS = [
  "20260624120000_expense_module_upgrade",
  "20260626000000_ensure_expense_tables",
  "20260626140000_add_sale_card_fields",
];

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

for (const name of TARGETS) {
  const { rows } = await client.query(
    `SELECT 1 FROM "_prisma_migrations"
     WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    [name],
  );
  if (rows.length > 0) {
    console.log(`[reconcile] ${name} already applied — skip`);
    continue;
  }

  // Checksum = hex(sha256(migration.sql bytes)) — exactly what Prisma stores/validates.
  const sql = readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"));
  const checksum = createHash("sha256").update(sql).digest("hex");

  // Clear any stale/failed/rolled-back rows for this migration, then insert a clean applied row.
  await client.query(`DELETE FROM "_prisma_migrations" WHERE migration_name = $1`, [name]);
  await client.query(
    `INSERT INTO "_prisma_migrations"
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES ($1, $2, NOW(), $3, NULL, NULL, NOW(), 1)`,
    [randomUUID(), checksum, name],
  );
  console.log(`[reconcile] recorded ${name} as applied (checksum ${checksum.slice(0, 12)}…)`);
}

await client.end();
console.log("[reconcile] done");

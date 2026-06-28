/**
 * One-time migration history reconciliation.
 *
 * Three migration folders exist in prisma/migrations but were never recorded in
 * the host's `_prisma_migrations` table (their columns already exist in the DB
 * via earlier idempotent boot scripts). This records them as applied — WITHOUT
 * re-running their SQL — so `prisma migrate deploy` sees a clean, consistent
 * history again and future migrations apply normally.
 *
 * Safe: only touches the bookkeeping rows for these 3 specific migrations,
 * never any data and never the already-applied migrations.
 */
import { execSync } from "node:child_process";
import process from "node:process";
import pkg from "pg";

const { Client } = pkg;

const TARGETS = [
  "20260624120000_expense_module_upgrade",
  "20260626000000_ensure_expense_tables",
  "20260626140000_add_sale_card_fields",
];

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
  // Drop any stale/failed/rolled-back bookkeeping rows for this migration so
  // `resolve --applied` can baseline it cleanly.
  await client.query(`DELETE FROM "_prisma_migrations" WHERE migration_name = $1`, [name]);
  try {
    execSync(`npx prisma migrate resolve --applied ${name}`, { stdio: "inherit" });
    console.log(`[reconcile] marked ${name} as applied`);
  } catch (err) {
    console.error(`[reconcile] could not resolve ${name}:`, err.message);
  }
}

await client.end();
console.log("[reconcile] done");

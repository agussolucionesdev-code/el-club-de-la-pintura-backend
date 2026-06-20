#!/usr/bin/env bash
#
# backup-db.sh — point-in-time logical backup of the production database.
#
# A bridge until a managed Postgres with automatic backups is in place. Runs a
# compressed pg_dump of $DATABASE_URL and keeps the last N copies locally (or in
# a mounted volume / object-storage path you point BACKUP_DIR at).
#
# Usage:
#   DATABASE_URL=postgres://... ./scripts/backup-db.sh
#
# Env:
#   DATABASE_URL  (required)  connection string to dump
#   BACKUP_DIR    (optional)  where to write dumps        [default: ./backups]
#   RETENTION     (optional)  how many dumps to keep      [default: 14]
#
# Schedule it daily, e.g. a Render Cron Job or crontab:
#   0 3 * * *  cd /app && DATABASE_URL=$DATABASE_URL ./scripts/backup-db.sh
#
# Restore a dump with:
#   gunzip -c backups/elclub-YYYYmmdd-HHMMSS.sql.gz | psql "$TARGET_DATABASE_URL"
# Always restore into a SCRATCH database first and verify row counts — never
# straight over production.

set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${RETENTION:-14}"

mkdir -p "$BACKUP_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
outfile="$BACKUP_DIR/elclub-$timestamp.sql.gz"

echo "[backup] dumping database -> $outfile"
# --no-owner / --no-privileges keep the dump portable across roles/hosts.
pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$outfile"

size="$(du -h "$outfile" | cut -f1)"
echo "[backup] done ($size)"

# Prune old dumps, keeping the most recent $RETENTION.
mapfile -t dumps < <(ls -1t "$BACKUP_DIR"/elclub-*.sql.gz 2>/dev/null || true)
if (( ${#dumps[@]} > RETENTION )); then
  for old in "${dumps[@]:RETENTION}"; do
    echo "[backup] pruning $old"
    rm -f "$old"
  done
fi

echo "[backup] retention: keeping up to $RETENTION dumps in $BACKUP_DIR"

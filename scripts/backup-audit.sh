#!/usr/bin/env bash
# backup-audit.sh — Audit log backup (separate from main DB)
# Audit logs are the selling point — extra protection
# Usage: backup-audit.sh [backup_dir]
# Schedule via cron: 0 3 * * * /path/to/backup-audit.sh /backups/audit

set -euo pipefail

BACKUP_DIR="${1:-/backups/clinic-mvp/audit}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/audit_logs_${TIMESTAMP}.sql.gz"
RETENTION_DAYS="${DATA_RETENTION_DAYS:-730}"  # 2 years for audit (stricter)
OFFSITE_DIR="${BACKUP_DIR}/offsite"

COMPOSE_PROJECT="clinic-workforce-mvp"
DB_CONTAINER="${COMPOSE_PROJECT}-db-1"

mkdir -p "${BACKUP_DIR}" "${OFFSITE_DIR}"

echo "🔒 [$(date)] Starting audit log backup..."

# Dump only the audit_logs table (and related daily_hashes for chain integrity)
docker exec "${DB_CONTAINER}" pg_dump \
  -U "${DB_USER:-clinic}" \
  -d clinic_mvp \
  --format=plain \
  --no-owner \
  --no-acl \
  --table=public.audit_logs \
  --table=public.daily_hashes \
  --table=public.punch_records \
  --verbose 2>&1 | gzip > "${BACKUP_FILE}"

if [ ! -s "${BACKUP_FILE}" ]; then
  echo "❌ Audit backup failed: empty or missing file"
  exit 1
fi

FILE_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "✅ Audit backup: ${BACKUP_FILE} (${FILE_SIZE})"

# Offsite copy
cp "${BACKUP_FILE}" "${OFFSITE_DIR}/"
echo "✅ Offsite copy done"

# Checksum
sha256sum "${BACKUP_FILE}" > "${BACKUP_FILE}.sha256"
cp "${BACKUP_FILE}.sha256" "${OFFSITE_DIR}/"

# Clean old audit backups (longer retention)
find "${BACKUP_DIR}" -maxdepth 1 -name "audit_logs_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
find "${OFFSITE_DIR}" -maxdepth 1 -name "audit_logs_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -maxdepth 1 -name "audit_logs_*.sha256" -mtime +"${RETENTION_DAYS}" -delete
find "${OFFSITE_DIR}" -maxdepth 1 -name "audit_logs_*.sha256" -mtime +"${RETENTION_DAYS}" -delete

echo "🧹 Old audit backups cleaned (retention: ${RETENTION_DAYS} days)"
echo "🎉 [$(date)] Audit backup complete"

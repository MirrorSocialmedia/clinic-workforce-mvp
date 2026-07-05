#!/usr/bin/env bash
# backup.sh — Daily PostgreSQL database backup + offsite copy
# Usage: backup.sh [backup_dir]
# Schedule via cron: 0 2 * * * /path/to/backup.sh /backups

set -euo pipefail

BACKUP_DIR="${1:-/backups/clinic-mvp}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/clinic_mvp_${TIMESTAMP}.sql.gz"
RETENTION_DAYS="${DATA_RETENTION_DAYS:-30}"
OFFSITE_DIR="${BACKUP_DIR}/offsite"  # Mount to remote/external volume

# Docker Compose project name (adjust if different)
COMPOSE_PROJECT="clinic-workforce-mvp"
DB_CONTAINER="${COMPOSE_PROJECT}-db-1"

# Ensure directories exist
mkdir -p "${BACKUP_DIR}" "${OFFSITE_DIR}"

echo "🔧 [$(date)] Starting backup..."

# Run pg_dump inside the Docker container
docker exec "${DB_CONTAINER}" pg_dump \
  -U "${DB_USER:-clinic}" \
  -d clinic_mvp \
  --format=plain \
  --no-owner \
  --no-acl \
  --verbose 2>&1 | gzip > "${BACKUP_FILE}"

# Verify backup file exists and is non-empty
if [ ! -s "${BACKUP_FILE}" ]; then
  echo "❌ Backup failed: empty or missing file"
  exit 1
fi

FILE_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "✅ Backup created: ${BACKUP_FILE} (${FILE_SIZE})"

# Copy to offsite directory (external volume / rsync target)
cp "${BACKUP_FILE}" "${OFFSITE_DIR}/"
echo "✅ Offsite copy: ${OFFSITE_DIR}/$(basename ${BACKUP_FILE})"

# Generate checksum
sha256sum "${BACKUP_FILE}" > "${BACKUP_FILE}.sha256"
cp "${BACKUP_FILE}.sha256" "${OFFSITE_DIR}/"
echo "✅ Checksum saved"

# Clean up old backups beyond retention period
find "${BACKUP_DIR}" -maxdepth 1 -name "clinic_mvp_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
find "${OFFSITE_DIR}" -maxdepth 1 -name "clinic_mvp_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -maxdepth 1 -name "clinic_mvp_*.sha256" -mtime +"${RETENTION_DAYS}" -delete
find "${OFFSITE_DIR}" -maxdepth 1 -name "clinic_mvp_*.sha256" -mtime +"${RETENTION_DAYS}" -delete
echo "🧹 Old backups cleaned (retention: ${RETENTION_DAYS} days)"

echo "🎉 [$(date)] Backup complete"

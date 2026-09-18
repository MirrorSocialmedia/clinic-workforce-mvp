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

COMPOSE_PROJECT="clinic-workforce-mvp"
DB_CONTAINER="${DB_CONTAINER:-clinic-prod-db}"

mkdir -p "${BACKUP_DIR}"

echo "🔒 [$(date)] Starting audit log backup..."

# Dump only the audit_logs table (and related daily_hashes for chain integrity)
docker exec "${DB_CONTAINER}" pg_dump \
  -U "${DB_USER:-clinic}" \
  -d clinic_prod \
  --format=plain \
  --no-owner \
  --no-acl \
  --table='"AuditLog"' \
  --table='"DailyHash"' \
  --table='"PunchRecord"' \
  --table='"PunchVoid"' \
  --table='"PunchCorrection"' \
  | gzip > "${BACKUP_FILE}"

if [ ! -s "${BACKUP_FILE}" ]; then
  echo "❌ Audit backup failed: empty or missing file"
  exit 1
fi

FILE_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "✅ Audit backup: ${BACKUP_FILE} (${FILE_SIZE})"

# Checksum
sha256sum "${BACKUP_FILE}" > "${BACKUP_FILE}.sha256"

# Offsite（★ cwm-ops：加密後推異地，同 backup.sh 口徑）
if [ -f /home/clinicapp/.backup_age_pub ] && command -v age >/dev/null && command -v rclone >/dev/null; then
  age -R /home/clinicapp/.backup_age_pub -o "${BACKUP_FILE}.age" "${BACKUP_FILE}"
  rclone copy "${BACKUP_FILE}.age" offsite:clinic-backups/ \
    && rclone copy "${BACKUP_FILE}.sha256" offsite:clinic-backups/ \
    && rm -f "${BACKUP_FILE}.age" \
    || { echo "❌ 異地備份失敗"; exit 1; }
else
  echo "⚠️ 未設定 age／rclone —— 今次冇異地備份"; exit 1
fi

# Clean old audit backups (longer retention)
find "${BACKUP_DIR}" -maxdepth 1 -name "audit_logs_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -maxdepth 1 -name "audit_logs_*.sha256" -mtime +"${RETENTION_DAYS}" -delete

echo "🧹 Old audit backups cleaned (retention: ${RETENTION_DAYS} days)"
echo "🎉 [$(date)] Audit backup complete"

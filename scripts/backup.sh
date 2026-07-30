#!/usr/bin/env bash
# backup.sh — Daily PostgreSQL database backup + offsite copy
# Usage: backup.sh [backup_dir]
# Schedule via cron: 0 2 * * * /path/to/backup.sh /backups

set -euo pipefail

BACKUP_DIR="${1:-/backups/clinic-mvp}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/clinic_prod_${TIMESTAMP}.sql.gz"
RETENTION_DAYS="${DATA_RETENTION_DAYS:-30}"
OFFSITE_DIR="${BACKUP_DIR}/offsite"  # Mount to remote/external volume

# Docker container name (must match running container)
DB_CONTAINER="clinic-prod-db"
DB_NAME="clinic_prod"

# Ensure directories exist
mkdir -p "${BACKUP_DIR}" "${OFFSITE_DIR}"

echo "🔧 [$(date)] Starting backup..."

# Run pg_dump inside the Docker container (improved: separate steps so errors are visible)
TMP_SQL="${BACKUP_DIR}/.tmp_${TIMESTAMP}.sql"
if ! docker exec "${DB_CONTAINER}" pg_dump \
  -U "${DB_USER:-clinic}" \
  -d "${DB_NAME}" \
  --format=plain \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  > "${TMP_SQL}" 2> "${BACKUP_DIR}/.last_error.log"; then
  echo "❌ pg_dump 失敗，見 ${BACKUP_DIR}/.last_error.log"
  rm -f "${TMP_SQL}"
  exit 1
fi

gzip -c "${TMP_SQL}" > "${BACKUP_FILE}"
rm -f "${TMP_SQL}"

# Verify backup file exists and is non-empty
if [ ! -s "${BACKUP_FILE}" ]; then
  echo "❌ Backup failed: empty or missing file"
  exit 1
fi

FILE_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "✅ Backup created: ${BACKUP_FILE} (${FILE_SIZE})"

# ★ 驗證備份真係有資料 —— 2026-07-22 事故：DB 空咗時做 backup，
#   檔案有 schema 所以非空、checksum 正常，但業務資料一筆都冇。
echo "🔍 驗證備份內容..."

# ① live DB 應該有幾多
LIVE=$(docker exec "${DB_CONTAINER}" psql -U "${DB_USER:-clinic}" -d "${DB_NAME}" -At -F',' -c \
'SELECT (SELECT count(*) FROM "User"),
        (SELECT count(*) FROM "Employee"),
        (SELECT count(*) FROM "Shift"),
        (SELECT count(*) FROM "PunchRecord"),
        (SELECT count(*) FROM "PayrollItem");')
IFS=',' read -r L_USER L_EMP L_SHIFT L_PUNCH L_ITEM <<< "${LIVE}"

# ② 備份檔實際入咗幾多（數 COPY 區塊行數）
count_copy() {
  gunzip -c "${BACKUP_FILE}" | awk -v tbl="$1" '
    $0 ~ "^COPY public\\."" tbl """ " { inblk=1; n=0; next }
    inblk && /^\\.$/ { print n; exit }
    inblk { n++ }
  '
}
B_USER=$(count_copy User);        B_EMP=$(count_copy Employee)
B_SHIFT=$(count_copy Shift);      B_PUNCH=$(count_copy PunchRecord)
B_ITEM=$(count_copy PayrollItem)

printf '   %-13s live=%-7s backup=%s\n' \
  User "${L_USER}" "${B_USER:-0}" \
  Employee "${L_EMP}" "${B_EMP:-0}" \
  Shift "${L_SHIFT}" "${B_SHIFT:-0}" \
  PunchRecord "${L_PUNCH}" "${B_PUNCH:-0}" \
  PayrollItem "${L_ITEM}" "${B_ITEM:-0}"

# ③ live 有資料但備份 0 筆 → 失敗
VERIFY_FAIL=0
chk() {
  if [ "$2" -gt 0 ] && [ "${3:-0}" -eq 0 ]; then
    echo "❌ $1：live ${2} 筆但備份 0 筆"
    VERIFY_FAIL=1
  fi
}
chk User "${L_USER}" "${B_USER}"
chk Employee "${L_EMP}" "${B_EMP}"
chk Shift "${L_SHIFT}" "${B_SHIFT}"
chk PunchRecord "${L_PUNCH}" "${B_PUNCH}"
chk PayrollItem "${L_ITEM}" "${B_ITEM}"

if [ "${VERIFY_FAIL}" -eq 1 ]; then
  echo "❌ 備份內容驗證失敗 —— 呢個備份唔可靠，唔好用嚟 restore。"
  echo "   檔案保留喺 ${BACKUP_FILE} 供檢查。"
  exit 1
fi
echo "✅ 備份內容驗證通過"

# ④ 行數寫入 sidecar，日後 restore 前可以核對
printf 'User=%s\nEmployee=%s\nShift=%s\nPunchRecord=%s\nPayrollItem=%s\n' \
  "${B_USER:-0}" "${B_EMP:-0}" "${B_SHIFT:-0}" "${B_PUNCH:-0}" "${B_ITEM:-0}" \
  > "${BACKUP_FILE}.rows"

# Copy to offsite directory (external volume / rsync target)
cp "${BACKUP_FILE}" "${OFFSITE_DIR}/"
cp "${BACKUP_FILE}.rows" "${OFFSITE_DIR}/"
echo "✅ Offsite copy: ${OFFSITE_DIR}/$(basename ${BACKUP_FILE})"

# Generate checksum
sha256sum "${BACKUP_FILE}" > "${BACKUP_FILE}.sha256"
cp "${BACKUP_FILE}.sha256" "${OFFSITE_DIR}/"
echo "✅ Checksum saved"

# Clean up old backups beyond retention period
find "${BACKUP_DIR}" -maxdepth 1 -name "clinic_prod_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
find "${OFFSITE_DIR}" -maxdepth 1 -name "clinic_prod_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -maxdepth 1 -name "clinic_prod_*.sha256" -mtime +"${RETENTION_DAYS}" -delete
find "${OFFSITE_DIR}" -maxdepth 1 -name "clinic_prod_*.sha256" -mtime +"${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -maxdepth 1 -name "clinic_prod_*.rows" -mtime +"${RETENTION_DAYS}" -delete
find "${OFFSITE_DIR}" -maxdepth 1 -name "clinic_prod_*.rows" -mtime +"${RETENTION_DAYS}" -delete
echo "🧹 Old backups cleaned (retention: ${RETENTION_DAYS} days)"

echo "🎉 [$(date)] Backup complete"

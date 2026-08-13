#!/usr/bin/env bash
# backup.sh — Daily PostgreSQL database backup
# Usage: backup.sh [backup_dir]
# Schedule via cron: 0 2 * * * /path/to/backup.sh /backups

set -euo pipefail

BACKUP_DIR="${1:-/backups/clinic-mvp}"
mkdir -p "${BACKUP_DIR}"

exec 9>"${BACKUP_DIR}/.lock"
flock -n 9 || { echo "另一個 backup 進行中，跳過"; exit 0; }

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/clinic_prod_${TIMESTAMP}.sql.gz"
RETENTION_DAYS="${DATA_RETENTION_DAYS:-30}"

# Docker container name (must match running container)
DB_CONTAINER="${DB_CONTAINER:-clinic-prod-db}"
DB_NAME="${DB_NAME:-clinic_prod}"
DB_USER="${DB_USER:-clinic}"

TABLES="User Employee Shift PunchRecord PayrollItem \
LeaveRequest LeaveBalance LeaveType \
TimeBank TimeBankEntry PayRule WageHistory \
PunchCorrection PunchVoid AuditLog \
Clinic Company ShiftTemplate ExpenseEntry HKPublicHoliday"

echo "🔧 [$(date)] Starting backup..."

# Run pg_dump inside the Docker container (improved: separate steps so errors are visible)
TMP_SQL="${BACKUP_DIR}/.tmp_${TIMESTAMP}.sql"
trap 'rm -f "${TMP_SQL:-}" "${COUNTS_TMP:-}" 2>/dev/null || true' EXIT

AVAIL_KB=$(df -Pk "${BACKUP_DIR}" | awk 'NR==2{print $4}')
if [ "${AVAIL_KB}" -lt 5242880 ]; then
 echo " ⚠️ 磁碟空間不足（剩餘 ${AVAIL_KB}KB < 5GB），備份可能失敗"
fi

if ! docker exec "${DB_CONTAINER}" pg_dump \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  --format=plain \
  --no-owner \
  --no-acl \
  --clean \
  --if-exists \
  > "${TMP_SQL}" 2> "${BACKUP_DIR}/.err_${TIMESTAMP}.log"; then
  echo "❌ pg_dump 失敗"
  exit 1
fi

gzip -c "${TMP_SQL}" > "${BACKUP_FILE}"
rm -f "${TMP_SQL}"

# ★ 一次過數晒所有表，避免 gunzip 18 次
COUNTS_TMP="${BACKUP_DIR}/.counts_${TIMESTAMP}"
gunzip -c "${BACKUP_FILE}" | awk '
BEGIN { inblk = 0 }
inblk == 0 && index($0, "COPY public.\"") == 1 {
 s = substr($0, 14)
 q = index(s, "\"")
 if (q > 1) { tbl = substr(s, 1, q - 1); inblk = 1; n[tbl] = 0 }
 next
}
inblk == 1 && $0 == "\\." { inblk = 0; next }
inblk == 1 { n[tbl]++ }
END { for (t in n) printf "%s=%s\n", t, n[t] }
' > "${COUNTS_TMP}"

# Verify backup file exists and is non-empty
if [ ! -s "${BACKUP_FILE}" ]; then
  echo "❌ Backup failed: empty or missing file"
  exit 1
fi

FILE_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
echo "✅ Backup created: ${BACKUP_FILE} (${FILE_SIZE})"

# ★ 驗證備份真係有資料 —— 2026-07-22 事故：DB 空咗時做 backup，
#   檔案有 schema 所以非空、checksum 正常，但業務資料一筆都冇。

# ② 備份檔實際入咗幾多（數 COPY 區塊行數）
count_copy() {
 awk -F= -v t="$1" '$1 == t { print $2; found = 1 } END { if (!found) print 0 }' "${COUNTS_TMP}"
}

VERIFY_FAIL=0
: > "${BACKUP_FILE}.rows"
TABLE_COUNT=$(echo ${TABLES} | wc -w)
echo "🔍 驗證備份內容（${TABLE_COUNT} 張表）..."
for TBL in ${TABLES}; do
 LIVE_N="$(docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" \
  -tAc "SELECT count(*) FROM \"${TBL}\";" 2>/dev/null || echo "SKIP")"
 if [ "${LIVE_N}" = "SKIP" ]; then
  echo " ⚠️ ${TBL}: 表唔存在，跳過"
  continue
 fi
 BK_N="$(count_copy "${TBL}")"
 printf ' %-18s live=%-8s backup=%s\n' "${TBL}" "${LIVE_N}" "${BK_N:-0}"
 printf '%s=%s\n' "${TBL}" "${BK_N:-0}" >> "${BACKUP_FILE}.rows"
 if [ "${LIVE_N}" -gt 0 ] && [ "${BK_N:-0}" -eq 0 ]; then
  echo " ❌ ${TBL}：live ${LIVE_N} 筆但備份 0 筆"
  VERIFY_FAIL=1
 fi
 if [ "${LIVE_N}" -gt 100 ]; then
  THRESHOLD=$(( LIVE_N * 90 / 100 ))
  if [ "${BK_N:-0}" -lt "${THRESHOLD}" ]; then
   echo " ⚠️ ${TBL}：備份 ${BK_N:-0} 遠少過 live ${LIVE_N}（<90%）—— 請人手確認"
  fi
 fi
done

if [ "${VERIFY_FAIL}" -eq 1 ]; then
 echo ""
 echo "❌ 備份驗證失敗"
 echo "${ERR_MSG:-}" > "${BACKUP_DIR}/.err_${TIMESTAMP}.log" 2>/dev/null || true
 exit 1
fi
echo "✅ 備份內容驗證通過"

# Generate checksum
sha256sum "${BACKUP_FILE}" > "${BACKUP_FILE}.sha256"
echo "✅ Checksum saved"

# Clean up old backups beyond retention period
find "${BACKUP_DIR}" -maxdepth 1 -name "clinic_prod_*.sql.gz" -mtime +"${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -maxdepth 1 -name "clinic_prod_*.sha256" -mtime +"${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -maxdepth 1 -name "clinic_prod_*.rows" -mtime +"${RETENTION_DAYS}" -delete
find "${BACKUP_DIR}" -maxdepth 1 -name ".tmp_*.sql" -mtime +1 -delete
find "${BACKUP_DIR}" -maxdepth 1 -name ".err_*.log" -mtime +30 -delete
echo "🧹 Old backups cleaned (retention: ${RETENTION_DAYS} days)"

echo "🎉 [$(date)] Backup complete"
echo ""
echo "📋 要 copy 落本地嘅【三個】檔案："
echo " ${BACKUP_FILE}"
echo " ${BACKUP_FILE}.sha256"
echo " ${BACKUP_FILE}.rows"
echo ""
echo " 一次過 copy："
echo " scp <user>@<host>:'${BACKUP_FILE}*' ./"
echo ""
echo " ★ copy 完喺本地驗一次："
echo " sha256sum -c $(basename "${BACKUP_FILE}").sha256"

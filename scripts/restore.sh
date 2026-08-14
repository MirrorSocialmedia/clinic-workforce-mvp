#!/usr/bin/env bash
# restore.sh — Restore database from backup
# Usage: restore.sh <backup_file.sql.gz>
# WARNING: This will DROP and recreate the database!

set -euo pipefail

# ★ Log all output to file
exec > >(tee -a "${HOME}/restore_$(date +%F_%H%M%S).log") 2>&1

# ★ Disk space check
AVAIL_KB=$(df -Pk "${HOME}" | awk 'NR==2{print $4}')
if [ "${AVAIL_KB}" -lt 2097152 ]; then
  echo " ⚠️ 磁碟空間不足（剩餘 ${AVAIL_KB}KB < 2GB），還原可能失敗"
fi

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup_file.sql.gz>"
  echo ""
  echo "Available backups:"
  SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  for D in \
    "/backups/clinic-mvp" \
    "/backups/clinic-mvp/offsite" \
    "${HOME}/backups" \
    "${SCRIPT_ROOT}/backups"; do
    [ -d "${D}" ] || continue
    FOUND="$(find "${D}" -maxdepth 1 -name '*.sql.gz' -type f 2>/dev/null | sort -r | head -5)"
    [ -z "${FOUND}" ] && continue
    echo " [${D}]"
    echo "${FOUND}" | sed 's/^/ /'
  done
  exit 1
fi

BACKUP_FILE="$1"
APP_CONTAINER="clinic-prod-app"
DB_CONTAINER="clinic-prod-db"
DB_NAME="clinic_prod"
DB_USER="${DB_USER:-clinic}"

# Verify backup exists
if [ ! -f "${BACKUP_FILE}" ]; then
  echo "❌ Backup file not found: ${BACKUP_FILE}"
  exit 1
fi

# Verify checksum if available
CHECKSUM_FILE="${BACKUP_FILE}.sha256"
if [ -f "${CHECKSUM_FILE}" ]; then
  echo "🔍 Verifying checksum..."
  if sha256sum -c "${CHECKSUM_FILE}" --quiet 2>/dev/null; then
    echo "✅ Checksum verified"
  else
    echo "❌ Checksum mismatch! Backup may be corrupted."
    echo "   Refusing to restore. Fix the backup file first."
    exit 1
  fi
fi

# Confirm with user
echo ""
echo "⚠️  WARNING: This will restore the database from:"
echo "   ${BACKUP_FILE}"
echo "   Current data will be replaced!"
echo ""
read -p "Type 'RESTORE' to confirm: " CONFIRM
if [ "${CONFIRM}" != "RESTORE" ]; then
  echo "Aborted."
  exit 0
fi

echo "🔧 [$(date)] Starting restore..."

# ★ Pre-restore safety backup — protect current state before dropping
SAFETY="${HOME}/backups/pre-restore-$(date +%Y%m%d_%H%M%S).sql.gz"
mkdir -p "${HOME}/backups"
echo "🛟 先備份現況到 ${SAFETY} ..."
docker exec "${DB_CONTAINER}" pg_dump -U "${DB_USER}" \
  --clean --if-exists --no-owner --no-acl "${DB_NAME}" | gzip > "${SAFETY}"

if [ ! -s "${SAFETY}" ] || [ "$(stat -c%s "${SAFETY}")" -lt 1000 ]; then
  echo "❌ 現況備份失敗（檔案過細），為安全起見中止還原。"
  exit 1
fi
gzip -t "${SAFETY}" || { echo "❌ 安全備份損毀，中止"; exit 1; }
echo "✅ 現況已備份"

# Check that DB container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
  echo "❌ 容器 ${DB_CONTAINER} 未運行，無法恢復"
  exit 1
fi

# ★ Trap to always restore restart policy, even on failure
trap 'docker update --restart=unless-stopped "${APP_CONTAINER}" >/dev/null 2>&1 || true; \
 docker start "${APP_CONTAINER}" >/dev/null 2>&1 || true; \
 echo "🔁 (trap) app 容器已嘗試起返"' EXIT

# Stop app container and disable auto-restart to prevent reconnection
echo "⏸️  停止 web 容器並關閉自動重啟..."
docker update --restart=no "${APP_CONTAINER}" >/dev/null 2>&1 || true
docker stop "${APP_CONTAINER}" >/dev/null 2>&1 || true
sleep 2

# ★ Force terminate lingering database connections
echo "🔌 強制斷開殘留連接..."
docker exec "${DB_CONTAINER}" psql \
  -U "${DB_USER}" \
  -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true

# Drop and recreate database for clean restore
echo "🗑️  清空舊資料庫..."
docker exec "${DB_CONTAINER}" psql \
  -U "${DB_USER}" \
  -d postgres \
  -c "DROP DATABASE IF EXISTS ${DB_NAME};"

docker exec "${DB_CONTAINER}" psql \
  -U "${DB_USER}" \
  -d postgres \
  -c "CREATE DATABASE ${DB_NAME};"

# Restore the dump (clean database, no conflicts)
echo "📥 灌入資料..."
RESTORE_ERR="/tmp/restore_err_$(date +%s).log"
if ! gunzip -c "${BACKUP_FILE}" | docker exec -i "${DB_CONTAINER}" psql \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  -v ON_ERROR_STOP=1 \
  --quiet 2> "${RESTORE_ERR}"; then
  echo "❌ 還原過程有 SQL 錯誤，已中止。"
  echo " 錯誤詳情：${RESTORE_ERR}"
  tail -20 "${RESTORE_ERR}"
  echo ""
  echo " ⚠️ 資料庫而家係【不完整】狀態。"
  echo " ⚠️ 可以用開頭嗰個安全備份還原返：${SAFETY}"
  exit 1
fi
echo "✅ 資料灌入完成"

# ★ Post-restore data summary
echo "📊 還原後資料摘要："
docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" -c \
'SELECT
   (SELECT count(*) FROM "User")        AS users,
   (SELECT count(*) FROM "Employee")    AS employees,
   (SELECT count(*) FROM "Shift")       AS shifts,
   (SELECT count(*) FROM "PunchRecord") AS punches,
   (SELECT max("punchTime") FROM "PunchRecord") AS latest_punch,
   (CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '"'"'PaymentAllocation'"'"' AND table_schema = '"'"'public'"'"') THEN (SELECT count(*) FROM "PaymentAllocation") ELSE 0 END) AS allocs,
   (CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '"'"'PayoutRun'"'"' AND table_schema = '"'"'public'"'"') THEN (SELECT count(*) FROM "PayoutRun") ELSE 0 END) AS payouts,
   (CASE WHEN EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '"'"'CostCase'"'"' AND table_schema = '"'"'public'"'"') THEN (SELECT count(*) FROM "CostCase") ELSE 0 END) AS costs;'

# ★ 自動對比備份的 row counts
ROWS_FILE="${BACKUP_FILE}.rows"
if [ -f "${ROWS_FILE}" ]; then
  echo "🔍 對比備份的 row counts..."
  MISMATCH=0
  CHECKED=0
  while IFS='=' read -r TBL EXPECTED; do
    TBL="$(echo "${TBL}" | tr -d '[:space:]')"
    EXPECTED="$(echo "${EXPECTED}" | tr -d '[:space:]')"
    [ -z "${TBL}" ] && continue
    case "${EXPECTED}" in ''|*[!0-9]*) continue ;; esac
    ACTUAL="$(docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DB_NAME}" \
     -tAc "SELECT count(*) FROM \"${TBL}\";" 2>/dev/null || echo "ERR")"
    CHECKED=$((CHECKED + 1))
    if [ "${ACTUAL}" != "${EXPECTED}" ]; then
      echo " ❌ ${TBL}: 備份 ${EXPECTED} → 還原後 ${ACTUAL}"
      MISMATCH=1
    fi
  done < "${ROWS_FILE}"
  if [ "${MISMATCH}" -eq 1 ]; then
    echo ""
    echo "❌ Row count 對唔上 —— 還原可能不完整。"
    echo " ★ 唔好開返 app 俾人用，先查清楚。"
    echo " ★ 安全備份在：${SAFETY}"
    exit 1
  fi
  echo "✅ ${CHECKED} 張表 row count 全部一致"
else
  echo "⚠️ 冇 .rows 檔（這個備份多數係 deploy.sh 出的）—— 跳過自動對數"
  echo " ★ 請人手確認上面的摘要合不合理"
fi

# ★ 補跑 migration — 備份的 schema 可能落後於當前代碼
# ⚠️  migration 失敗唔可以係 fatal —— 資料已經成功還原
#    避免 set -euo pipefail 令 script 直接 exit 而跳過 restart + 提示

echo "🔧 補跑 migration (備份的 schema 可能落後於當前代碼)..."
docker start "${APP_CONTAINER}" >/dev/null 2>&1 || true

echo "⏳ 等待 app 就緒..."
for i in $(seq 1 6); do
  sleep 5
  if docker logs "${APP_CONTAINER}" 2>&1 | tail -5 | grep -q "ready\|listening\|started"; then
    break
  fi
done

MIGRATE_OK=1
docker exec "${APP_CONTAINER}" sh -c \
  "npx prisma migrate deploy --schema apps/web/prisma/schema.prisma" || MIGRATE_OK=0

echo "🔄 重啟 web 容器..."
docker restart "${APP_CONTAINER}" >/dev/null 2>&1 || true

if [ "${MIGRATE_OK}" -eq 1 ]; then
  echo "🎉 [$(date)] Restore complete — 資料已還原，migration 已套用"
else
  cat <<'EOF'

⚠️  資料已成功還原，但 migration 未完成。
    ★★ 唔好再 restore 一次 —— 資料係完好嘅。★★

    P3009 = 備份入面本身帶住「失敗嘅 migration 記錄」，還原幾多次都一樣。
    P3018 = 資料唔滿足新約束（例如唯一索引）。

    處理：
      1. 睇失敗嗰個 migration 嘅 SQL，清理對應髒資料
      2. docker exec clinic-prod-app sh -c \
           "npx prisma migrate resolve --rolled-back <migration_name> \
            --schema apps/web/prisma/schema.prisma"
      3. docker exec clinic-prod-app sh -c \
           "npx prisma migrate deploy --schema apps/web/prisma/schema.prisma"
EOF
fi

#!/usr/bin/env bash
# restore.sh — Restore database from backup
# Usage: restore.sh <backup_file.sql.gz>
# WARNING: This will DROP and recreate the database!

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup_file.sql.gz>"
  echo ""
  echo "Available backups:"
  find /backups -name "*.sql.gz" -type f 2>/dev/null | sort -r | head -10
  exit 1
fi

BACKUP_FILE="$1"
APP_CONTAINER="clinic-prod-app"
DB_CONTAINER="clinic-prod-db"
DB_NAME="clinic_prod"

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
docker exec "${DB_CONTAINER}" pg_dump -U "${DB_USER:-clinic}" \
  --clean --if-exists --no-owner --no-acl "${DB_NAME}" | gzip > "${SAFETY}"

if [ ! -s "${SAFETY}" ] || [ "$(stat -c%s "${SAFETY}")" -lt 1000 ]; then
  echo "❌ 現況備份失敗（檔案過細），為安全起見中止還原。"
  exit 1
fi
echo "✅ 現況已備份"

# Check that DB container is running
if ! docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
  echo "❌ 容器 ${DB_CONTAINER} 未運行，無法恢復"
  exit 1
fi

# ★ Trap to always restore restart policy, even on failure
trap 'docker update --restart=unless-stopped "${APP_CONTAINER}" >/dev/null 2>&1 || true' EXIT

# Stop app container and disable auto-restart to prevent reconnection
echo "⏸️  停止 web 容器並關閉自動重啟..."
docker update --restart=no "${APP_CONTAINER}" >/dev/null 2>&1 || true
docker stop "${APP_CONTAINER}" >/dev/null 2>&1 || true
sleep 2

# ★ Force terminate lingering database connections
echo "🔌 強制斷開殘留連接..."
docker exec "${DB_CONTAINER}" psql \
  -U "${DB_USER:-clinic}" \
  -d postgres \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${DB_NAME}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true

# Drop and recreate database for clean restore
echo "🗑️  清空舊資料庫..."
docker exec "${DB_CONTAINER}" psql \
  -U "${DB_USER:-clinic}" \
  -d postgres \
  -c "DROP DATABASE IF EXISTS ${DB_NAME};"

docker exec "${DB_CONTAINER}" psql \
  -U "${DB_USER:-clinic}" \
  -d postgres \
  -c "CREATE DATABASE ${DB_NAME};"

# Restore the dump (clean database, no conflicts)
gunzip -c "${BACKUP_FILE}" | docker exec -i "${DB_CONTAINER}" psql \
  -U "${DB_USER:-clinic}" \
  -d "${DB_NAME}"

# ★ Post-restore data summary
echo "📊 還原後資料摘要："
docker exec "${DB_CONTAINER}" psql -U "${DB_USER:-clinic}" -d "${DB_NAME}" -c \
'SELECT
   (SELECT count(*) FROM "User")        AS users,
   (SELECT count(*) FROM "Employee")    AS employees,
   (SELECT count(*) FROM "Shift")       AS shifts,
   (SELECT count(*) FROM "PunchRecord") AS punches,
   (SELECT max("punchTime") FROM "PunchRecord") AS latest_punch;'

# ★ 補跑 migration — 備份的 schema 可能落後於當前代碼
# ⚠️  migration 失敗唔可以係 fatal —— 資料已經成功還原
#    避免 set -euo pipefail 令 script 直接 exit 而跳過 restart + 提示

echo "🔧 補跑 migration (備份的 schema 可能落後於當前代碼)..."
docker start "${APP_CONTAINER}" >/dev/null 2>&1 || true
sleep 5

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

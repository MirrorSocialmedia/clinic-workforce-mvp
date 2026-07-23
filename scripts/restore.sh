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

# Start web container (trap will restore restart policy)
echo "▶️  重啟 web 容器..."
docker start "${APP_CONTAINER}" >/dev/null 2>&1 || true

echo "🎉 [$(date)] Restore complete"

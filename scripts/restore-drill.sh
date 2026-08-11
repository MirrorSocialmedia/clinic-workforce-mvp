#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups/clinic-mvp}"
DB_CONTAINER="${DB_CONTAINER:-clinic-prod-db}"
DB_USER="${DB_USER:-clinic}"

LATEST="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'clinic_prod_*.sql.gz' | sort -r | head -1)"
if [ -z "${LATEST}" ]; then
 echo "❌ 搵唔到備份檔"
 exit 1
fi

DRILL_DB="clinic_drill_$(date +%s)"
echo "🔧 創建演練 DB: ${DRILL_DB}"

docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d postgres \
 -c "CREATE DATABASE ${DRILL_DB};"

if gunzip -c "${LATEST}" | docker exec -i "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DRILL_DB}" \
 -v ON_ERROR_STOP=1 --quiet 2> /tmp/drill_err.log; then
 echo "✅ 演練還原成功：${LATEST}"
 docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d "${DRILL_DB}" -tAc \
  'SELECT (SELECT count(*) FROM "Employee"), (SELECT count(*) FROM "PayrollItem");'
else
 echo "❌ 演練還原失敗 —— 你嘅備份還原唔到！"
 tail -20 /tmp/drill_err.log
fi

docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d postgres \
 -c "DROP DATABASE ${DRILL_DB};"
echo "✅ 已刪除演練 DB"

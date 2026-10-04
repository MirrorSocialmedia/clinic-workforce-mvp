#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups/clinic-mvp}"
DB_CONTAINER="${DB_CONTAINER:-clinic-prod-db}"
DB_USER="${DB_USER:-clinic}"

if [ "${SKIP_DB_DRILL:-0}" = "1" ]; then
 echo "ℹ️ SKIP_DB_DRILL=1 —— 跳過 DB drill（例：本地無 docker，只跑 labdoc drill）"
else

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
 docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d postgres -c "DROP DATABASE IF EXISTS ${DRILL_DB};" || true
 exit 1
fi

docker exec "${DB_CONTAINER}" psql -U "${DB_USER}" -d postgres \
 -c "DROP DATABASE ${DRILL_DB};"
echo "✅ 已刪除演練 DB"

fi  # SKIP_DB_DRILL

# ────────────────────────────────────────────────────────────────────
# ★ cwm-labdoc P1（§4.5）：LabFile restore drill
# 隨機抽 ≤5 個未 purge 嘅 LabFile → 由備份源拉返 → 解密 → 比 sha256。
# 備份源：LAB_DOC_BACKUP_SOURCE（本地目錄，無 offsite 時 drill 用）
#   或者 rclone（offsite:clinic-backups/lab-docs/）。
# 解 key：LAB_DOC_ENC_KEY／LAB_DOC_ENC_KID／LAB_DOC_ENC_KEYS_OLD（要同生產一致）。
# 抽樣 DB：LAB_DOC_PSQL（例 'psql -h 127.0.0.1 -p 15532 -U cw_dev -d cwm_labdoc'）；
#   未設 = docker exec ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME}。
# 解密需要 host 有 node ≥18（可經 LAB_DOC_NODE 覆蓋）。
# ────────────────────────────────────────────────────────────────────
if [ -z "${LAB_DOC_ENC_KEY:-}" ]; then
  echo "ℹ️ LAB_DOC_ENC_KEY 未設 —— 跳過 labdoc drill"
  exit 0
fi
LAB_DOC_NODE="${LAB_DOC_NODE:-node}"
if ! command -v "${LAB_DOC_NODE}" >/dev/null; then
  echo "❌ 搵唔到 node（LAB_DOC_NODE=${LAB_DOC_NODE}）—— labdoc drill 需要 node ≥18"
  exit 1
fi
if [ -z "${LAB_DOC_BACKUP_SOURCE:-}" ] && ! command -v rclone >/dev/null; then
  echo "❌ labdoc drill 需要 LAB_DOC_BACKUP_SOURCE（本地目錄）或者 rclone（offsite）"
  exit 1
fi

SCRIPT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAB_DOC_PSQL="${LAB_DOC_PSQL:-docker exec ${DB_CONTAINER} psql -U ${DB_USER} -d ${DB_NAME}}"
RCLONE_REMOTE="${RCLONE_REMOTE:-offsite}"

SAMPLES=$(${LAB_DOC_PSQL} -tAc \
  "SELECT \"storageKey\" || ' ' || \"sha256\" FROM \"LabFile\" WHERE \"purgedAt\" IS NULL ORDER BY random() LIMIT 5;" \
  2>/dev/null) || { echo "❌ 抽 LabFile 樣本失敗"; exit 1; }
N=$(echo "${SAMPLES}" | grep -c . || true)
if [ "${N}" -eq 0 ]; then
  echo "ℹ️ DB 冇未 purge 嘅 LabFile —— 跳過 labdoc drill"
  exit 0
fi
echo "🔧 labdoc drill：抽 ${N} 個檔（≤5）還原＋解密＋比 sha256"

LAB_FAIL=0
DRILL_TMP="$(mktemp -d)"
trap 'rm -rf "${DRILL_TMP}"' EXIT

while read -r KEY SHA; do
  [ -z "${KEY}" ] && continue
  SRC_FILE="${DRILL_TMP}/$(echo "${KEY}" | tr '/' '_')"
  if [ -n "${LAB_DOC_BACKUP_SOURCE}" ]; then
    cp "${LAB_DOC_BACKUP_SOURCE}/${KEY}" "${SRC_FILE}" 2>/dev/null \
      || { echo " ❌ ${KEY}: 備份源冇呢個檔"; LAB_FAIL=1; continue; }
  else
    rclone copyto "${RCLONE_REMOTE}:clinic-backups/lab-docs/${KEY}" "${SRC_FILE}" 2>/dev/null \
      || { echo " ❌ ${KEY}: offsite 拉唔到"; LAB_FAIL=1; continue; }
  fi
  ACTUAL="$(LAB_DOC_ENC_KEY="${LAB_DOC_ENC_KEY}" LAB_DOC_ENC_KID="${LAB_DOC_ENC_KID:-k1}" LAB_DOC_ENC_KEYS_OLD="${LAB_DOC_ENC_KEYS_OLD:-}" \
    "${LAB_DOC_NODE}" "${SCRIPT_ROOT}/scripts/labdoc-restore-check.mjs" "${SRC_FILE}" 2>&1)" \
    || { echo " ❌ ${KEY}: 解密失敗：${ACTUAL}"; LAB_FAIL=1; continue; }
  if [ "${ACTUAL}" = "${SHA}" ]; then
    echo " ✅ ${KEY}: sha256 對得上"
  else
    echo " ❌ ${KEY}: sha256 唔同（期望 ${SHA}，實際 ${ACTUAL}）"
    LAB_FAIL=1
  fi
done <<< "${SAMPLES}"

if [ "${LAB_FAIL}" -eq 1 ]; then
  echo ""
  echo "❌ labdoc drill 失敗 —— 備份檔還原唔到！"
  exit 1
fi
echo "✅ labdoc drill 通過：${N} 個檔全部解密成功、sha256 對得上"

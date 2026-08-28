#!/usr/bin/env bash
# ============================================================
# QR token 清理 —— cron 入口（每日 04:00）
# trace: cwm-qrcron-20260828
#
# 部署（生產 host，唔係 container）：
#   crontab -e：
#     0 4 * * * <repo-root>/scripts/cleanup-qr-tokens.sh
#
# ★ 2026-08-28：合併兩個舊 script
#   · ~/clinic/scripts/cleanup-qr-tokens.sh（手動建，未入 git）
#   · apps/web/scripts/cleanup-qr-tokens.sh（repo，2>/dev/null 吞錯誤）
#   兩個都寫 /tmp/qr-cleanup.log，令人以為成功咗。
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

LOG=/tmp/qr-cleanup.log

# ★ cron 嘅 PATH 只有 /usr/bin:/bin —— 呢部機 docker 喺 user-local bin
#   （同 scripts/sync-availability.sh:26 一樣嘅問題）
export PATH="/home/clinicapp/bin:/usr/local/bin:/usr/bin:/bin"
command -v docker >/dev/null || {
  echo "$(date '+%F %T') ❌ 搵唔到 docker（PATH=$PATH）" >> "$LOG"; exit 1; }

# 防止重疊
exec 9>/tmp/.qr-cleanup.lock
flock -n 9 || { echo "$(date '+%F %T') 上次未完，跳過" >> "$LOG"; exit 0; }

TS=$(date '+%F %T')
BEFORE=$(docker exec clinic-prod-db psql -U clinic -d clinic_prod -tAc \
  'SELECT count(*) FROM "QRToken";')
USAGE_BEFORE=$(docker exec clinic-prod-db psql -U clinic -d clinic_prod -tAc \
  'SELECT count(*) FROM "QRTokenUsage";')

# ★ 只刪「過期一日以上」而且【冇人用過】嘅 token。
#   ⚠️ 有人用過嘅【永遠保留】—— QRTokenUsage 係 onDelete: Cascade，
#      刪 token 會連「邊個幾時用咗邊個碼」嘅打卡證據一齊抹走。
#   ⚠️ 一日緩衝：qr-token.ts 有 12 秒 race window，啱啱過期可能有人正掃緊。
TOTAL=0
while :; do
  N=$(docker exec clinic-prod-db psql -U clinic -d clinic_prod -tAc "
    WITH d AS (
      SELECT t.id FROM \"QRToken\" t
      WHERE t.\"expiresAt\" < now() - interval '1 day'
        AND NOT EXISTS (SELECT 1 FROM \"QRTokenUsage\" u WHERE u.\"tokenId\" = t.id)
      LIMIT 5000
    )
    DELETE FROM \"QRToken\" WHERE id IN (SELECT id FROM d)
    RETURNING 1;" | grep -c 1 || true)
  TOTAL=$((TOTAL + N))
  [ "$N" -lt 5000 ] && break
  sleep 1
done

AFTER=$(docker exec clinic-prod-db psql -U clinic -d clinic_prod -tAc \
  'SELECT count(*) FROM "QRToken";')
USAGE_AFTER=$(docker exec clinic-prod-db psql -U clinic -d clinic_prod -tAc \
  'SELECT count(*) FROM "QRTokenUsage";')

echo "$TS 刪咗 $TOTAL 筆　QRToken $BEFORE → $AFTER　QRTokenUsage $USAGE_BEFORE → $USAGE_AFTER" >> "$LOG"

# ★ 證據唔可以少 —— 少咗即係 cascade 刪錯咗
if [ "$USAGE_BEFORE" != "$USAGE_AFTER" ]; then
  echo "$TS ⛔ QRTokenUsage 由 $USAGE_BEFORE 變 $USAGE_AFTER —— 打卡證據被刪，即刻查！" >> "$LOG"
  exit 1
fi

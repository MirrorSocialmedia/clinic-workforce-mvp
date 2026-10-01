#!/usr/bin/env bash
# ============================================================
# 臨床索引 cron 入口（夜跑 / 回填）— cwm-apricotty-20261001
#
# 用法（喺生產【host】跑，同 scripts/sync-availability.sh 同一套機制）：
#   scripts/clinical-index.sh nightly            # 原帳號（MAIN）夜跑
#   scripts/clinical-index.sh backfill           # 原帳號回填（一次性；回 DONE 即刪 cron 行）
#   scripts/clinical-index.sh nightly TY         # 青衣帳號夜跑
#   scripts/clinical-index.sh backfill TY        # 青衣帳號 12 個月回填（一次性）
#
# 點解唔直接喺 crontab 寫 curl：生產 host → app localhost:3000 冇 map port（2026-08-21 確認），
#   host curl 打唔到。要 docker exec 入 clinic-prod-app 內部打；key 由 container env
#   （APRICOT_CRON_KEY）讀，host 唔使攞 secret。
#
# 防重疊：每個 job×帳號一把 flock（上次未完 → 跳過，exit 0）；app 入面另有
#   job 級 advisory lock（409 ALREADY_RUNNING）同 Apricot 全局鎖。
# log: /tmp/clinical-index-<job>[-<帳號細楷>].log
# ============================================================
set -euo pipefail

export PATH="/home/clinicapp/bin:/usr/local/bin:/usr/bin:/bin"
command -v docker >/dev/null || {
  echo "$(date '+%F %T') ❌ 搵唔到 docker（PATH=$PATH）"; exit 1;
}

JOB="${1:-}"
ACCOUNT="${2:-}"
case "$JOB" in
  nightly)  ROUTE=clinical-index-nightly ;;
  backfill) ROUTE=clinical-index-backfill ;;
  *) echo "用法：$0 nightly|backfill [帳號，例如 TY]"; exit 2 ;;
esac
if [ -n "$ACCOUNT" ] && ! [[ "$ACCOUNT" =~ ^[A-Z][A-Z0-9_]{0,15}$ ]]; then
  echo "帳號只准大楷英文／數字／底線（例如 TY）"; exit 2
fi

SUFFIX="${ACCOUNT:+-$(echo "$ACCOUNT" | tr 'A-Z' 'a-z')}"
LOG="/tmp/clinical-index-${JOB}${SUFFIX}.log"
QUERY="${ACCOUNT:+?account=$ACCOUNT}"

exec 9>"/tmp/.clinical-index-${JOB}${SUFFIX}.lock"
if ! flock -n 9; then
  echo "$(date '+%F %T') 上次未完，跳過" >> "$LOG"
  exit 0
fi

{
  echo "---- $(date '+%F %T') clinical-index ${JOB} ${ACCOUNT:-MAIN} 開始 ----"
  docker exec clinic-prod-app node -e "fetch('http://localhost:3000/api/internal/${ROUTE}${QUERY}',{method:'POST',headers:{'x-cron-key':process.env.APRICOT_CRON_KEY}}).then(async r=>{console.log(r.status, await r.text())}).catch(e=>{console.error('${ROUTE} fetch 失敗:',e);process.exit(1)})"
  echo ""
  echo "---- $(date '+%F %T') clinical-index ${JOB} ${ACCOUNT:-MAIN} 結束 ----"
} >> "$LOG" 2>&1

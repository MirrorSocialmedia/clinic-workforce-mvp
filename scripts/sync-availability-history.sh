#!/usr/bin/env bash
# ============================================================
# cwc-rdchain-20260823-a1: Patient Read 鏈低頻 history sync — cron 入口
# （read-chain MD §3.2：每晚 03:00，範圍 -7 → 昨日，追 status 變化）
#
# 部署（喺生產【host】跑，同 scripts/sync-availability.sh 同一套機制）：
#   crontab -e：
#     0 3 * * * <repo-root>/scripts/sync-availability-history.sh
#
# 同 15 分鐘 sync 嘅分別：
#   - 入路 = /api/internal/sync-availability-history（唔郁 AvailabilityCache —
#     只 upsert AppointmentIndex / PatientIndex 兩張索引表）
#   - 自己把 flock（同 15 分鐘 job 唔會互相擋住 — 兩邊各自防重疊；
#     Apricot 側序列化由 app 入面嘅 withApricotLock advisory lock 保證）
# log: /tmp/availability-sync-history.log
# ============================================================
set -euo pipefail

export PATH="/home/clinicapp/bin:/usr/local/bin:/usr/bin:/bin"
command -v docker >/dev/null || {
  echo "$(date '+%F %T') ❌ 搵唔到 docker（PATH=$PATH）"; exit 1;
}

LOG=/tmp/availability-sync-history.log

# ★ 防重疊（自己 scope 嘅 lock — 唔共用 /tmp/.availability-sync.lock，
#   避免 03:00 job 同最後一次 15 分鐘 tick 互相 skip）
exec 9>/tmp/.availability-sync-history.lock
if ! flock -n 9; then
  echo "$(date '+%F %T') 上次未完，跳過" >> "$LOG"
  exit 0
fi

{
  echo "---- $(date '+%F %T') availability history sync 開始 ----"
  docker exec clinic-prod-app node -e "fetch('http://localhost:3000/api/internal/sync-availability-history',{method:'POST',headers:{'x-cron-key':process.env.APRICOT_CRON_KEY}}).then(r=>r.text()).then(console.log).catch(e=>{console.error('sync-availability-history fetch 失敗:',e);process.exit(1)})"
  echo ""
  echo "---- $(date '+%F %T') availability history sync 結束 ----"
} >> "$LOG" 2>&1

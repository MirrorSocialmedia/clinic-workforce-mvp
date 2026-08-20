#!/usr/bin/env bash
# ============================================================
# cw-pa: Apricot 醫生時間表 availability sync — cron wrapper
# Spec: docs/specs/PROVIDER_AVAILABILITY_SPEC.md §4（排程）
#
# 排法（拍板②）：
#   */10 8-20     * * *  本腳本     # 日間每 10 分鐘（78 次）
#   0    21-23,0-7 * * *  本腳本     # 夜間每小時（11 次）
#   共 89 次/日 × 5 間接通店（一次 call 返滾動 7 日）
#
# 部署（只係部署文件 — 唔好喺本 repo 環境真 install cron）：
#   1. 生產機 crontab -e：
#        INTERNAL_SYNC_TOKEN=<同 .env 同一個值>
#        */10 8-20     * * * /opt/clinic-workforce/apps/web/scripts/cron-availability-sync.sh
#        0    21-23,0-7 * * * /opt/clinic-workforce/apps/web/scripts/cron-availability-sync.sh
#   2. INTERNAL_SYNC_TOKEN 必須同 web app 嘅 .env 一致（shared secret）。
#   3. log: /tmp/availability-sync.log（可用 logrotate 收）
#
# ★ flock 唔可以省 —— Apricot token 係共用三件套（嚴格序列化寫）。
#   上次未跑完（>180s）→ 今次直接跳過，唔會兩邊一齊打。
# ============================================================
set -euo pipefail

LOG=/tmp/availability-sync.log

# ★ env 缺咗 fail fast —— 唔好帶空 token 去撞 403 刷 log
: "${INTERNAL_SYNC_TOKEN:?INTERNAL_SYNC_TOKEN 未設（crontab 顶部 export 或 env line）}"

# ★ 防重疊：攞唔到 lock = 上次未完 → 記 log 後 exit 0（唔算錯誤）
exec 9>/tmp/.availability-sync.lock
if ! flock -n 9; then
  echo "$(date '+%F %T') 上次未完，跳過" >> "$LOG"
  exit 0
fi

{
  echo "---- $(date '+%F %T') availability sync 開始 ----"
  curl -sS -X POST "http://localhost:3000/api/internal/sync-availability" \
    -H "X-Internal-Token: ${INTERNAL_SYNC_TOKEN}" --max-time 180
  echo ""
  echo "---- $(date '+%F %T') availability sync 結束 ----"
} >> "$LOG" 2>&1

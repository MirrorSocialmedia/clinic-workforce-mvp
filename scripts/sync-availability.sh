#!/usr/bin/env bash
# ============================================================
# cw-pta: 醫生時間表 Apricot availability sync — cron 入口
# trace: cw-pta-20260821-a1 | Spec: 醫生時間表合併 spec §2（排程）
#
# 部署（喺生產【host】跑，唔係 container 入面）：
#   crontab -e：
#     */10 8-20     * * * <repo-root>/scripts/sync-availability.sh
#     0    21-23,0-7 * * * <repo-root>/scripts/sync-availability.sh
#   日間每 10 分鐘（8-20 點）+ 夜間每小時，共 ~89 次/日 × 5 間接通店。
#
# ★ 2026-08-21 老細確認：生產 host→app localhost:3000 port 冇 map（無通），
#   host curl 行唔到。改用 docker exec 入 clinic-prod-app 內部打：
#   - key 由 container env 讀（APRICOT_CRON_KEY，compose 已經注入）——
#     host 唔使讀 .env 攞 key（少咗一個 secret 暴露面）。
#   - 定期打 API 第二個作用：Apricot 係 sliding 7-day window，
#     每 7 日打一次就永遠唔死（keep refresh_token 不過期）。
#
# ★ flock 唔可以省 —— Apricot token 係共用三件套（嚴格序列化寫）。
#   上次未跑完（>180s）→ 今次直接跳過，唔會兩邊一齊打。
# log: /tmp/availability-sync.log（可用 logrotate 收）
# ============================================================
set -euo pipefail

LOG=/tmp/availability-sync.log

# ★ 防重疊：攞唔到 lock = 上次未完 → 記 log 後 exit 0（唔算錯誤）
exec 9>/tmp/.availability-sync.lock
if ! flock -n 9; then
  echo "$(date '+%F %T') 上次未完，跳過" >> "$LOG"
  exit 0
fi

{
  echo "---- $(date '+%F %T') availability sync 開始 ----"
  docker exec clinic-prod-app node -e "fetch('http://localhost:3000/api/internal/sync-availability',{method:'POST',headers:{'x-cron-key':process.env.APRICOT_CRON_KEY}}).then(r=>r.text()).then(console.log).catch(e=>{console.error('sync-availability fetch 失敗:',e);process.exit(1)})"
  echo ""
  echo "---- $(date '+%F %T') availability sync 結束 ----"
} >> "$LOG" 2>&1

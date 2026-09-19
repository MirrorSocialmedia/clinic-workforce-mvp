#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
DC="docker compose -p clinic -f $ROOT/docker-compose.yml"

echo "== 備份 =="
BK="$ROOT/backups/clinic_$(date +%F_%H%M).sql.gz"
mkdir -p "$ROOT/backups"
docker exec clinic-prod-db pg_dump -U clinic clinic_prod | gzip > $BK
echo " $BK"
[ "$(gzip -cd "$BK" | head -c 2000 | wc -c)" -gt 500 ] || { echo "❌ 備份檔異常（太細），中止"; exit 1; }
find "$ROOT/backups" -mtime +14 -delete

echo "== 拉代碼（先驗後落）=="
git fetch origin
CHECKS="check-rbac-matrix.sh check-role-hardcode.sh check-role-hardcode-api.sh \
 check-ownership.sh check-sensitive-coverage.sh check-audit-coverage.sh \
 check-duplicate-calc.sh check-get-no-store.sh check-balance-year.sh \
 check-apricot-boundary.sh check-payout-boundary.sh check-pii.sh check-dates.sh \
 check-company-scope.sh check-holiday-coverage.sh check-payroll-surface.sh check-catch-ignore.sh \
 check-export-cols.sh check-payroll-view-keys.sh"
GUARD_DIR="$(mktemp -d)"
git worktree add --detach "$GUARD_DIR" origin/main >/dev/null
GUARD_FAIL=0
for script in $CHECKS; do
  [ -f "$GUARD_DIR/scripts/$script" ] || continue
  echo "▶ $script"
  ( cd "$GUARD_DIR" && bash "scripts/$script" ) || { echo "❌ $script failed"; GUARD_FAIL=1; break; }
done
git worktree remove --force "$GUARD_DIR"
[ "$GUARD_FAIL" = 0 ] || { echo "❌ guard 未過 — 未 reset，host 保持舊版"; exit 1; }
git reset --hard origin/main

# Wiring check — info only, does not block deploy
echo "▶ check-wiring.sh"
bash "scripts/check-wiring.sh" || true

echo "== 清理舊 image（備份完成之後、build 之前）=="
# ★ 2026-08-28 cwm-costfix：build 前先 prune dangling image —— 防多餘 image 堆積
#   食晒磁碟令 build 失敗。best-effort（失敗唔擋部署）。
docker image prune -f > /dev/null 2>&1 || true

echo "== 重建 app（migration 檔在映像裡，build 必須在 migrate 之前）=="
if ! $DC up -d --build app; then
 echo ""
 echo "❌ 建置失敗 —— 上面通常有原因，最常見係："
 echo " · TypeScript error（next build 會做 typecheck）"
 echo " · pnpm install 失敗（lockfile / 網絡）"
 echo " 資料庫未改動，可以安全修好再跑一次。"
 exit 1
fi

echo "── Face service（warn-only，永不擋主站）──"
if $DC build face && $DC up -d face; then
 sleep 15
 if $DC exec app node -e "fetch('http://face:8000/health').then(r=>r.json()).then(d=>{if(!d.ok)process.exit(1)}).catch(()=>process.exit(1))" 2>/dev/null; then
  echo "✅ face service 健康"
 else
  echo "⚠️ face 未回應——打卡將標 SKIPPED，主站不受影響（$DC logs face 查）"
 fi
else
 echo "⚠️ face 建置/啟動失敗——同上，主站繼續部署"
fi

echo "== 套用 migration =="
$DC exec app npx prisma migrate deploy --schema apps/web/prisma/schema.prisma

echo "== 完成 =="
docker logs clinic-prod-app --tail 5

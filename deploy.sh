#!/bin/bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
DC="docker compose -p clinic -f $ROOT/docker-compose.yml"

echo "== 備份 =="
BK="$ROOT/backups/clinic_$(date +%F_%H%M).sql.gz"
mkdir -p "$ROOT/backups"
docker exec clinic-prod-db pg_dump -U clinic clinic_prod | gzip > $BK
echo " $BK"
find "$ROOT/backups" -mtime +14 -delete

echo "== 預部署靜態檢查 =="
for script in check-rbac-matrix.sh check-dates.sh check-role-hardcode.sh check-rbac-api.sh; do
  if [ -f "scripts/$script" ]; then
    echo "▶ $script"
    if [ "$script" = "check-dates.sh" ]; then
      # check-dates.sh: server-side zero hits = fail, frontend warnings = continue
      bash "scripts/$script" || { echo "❌ $script failed (server-side issues), aborting deploy"; exit 1; }
    else
      bash "scripts/$script" || { echo "❌ $script failed, aborting deploy"; exit 1; }
    fi
  fi
done

echo "== 拉代碼 =="
git pull

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

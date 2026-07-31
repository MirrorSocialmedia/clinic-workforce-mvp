#!/bin/bash
set -e
cd /home/clinicapp/clinic
DC="docker compose -p clinic -f /home/clinicapp/clinic/docker-compose.yml"

echo "== 備份 =="
BK=/home/clinicapp/clinic/backups/clinic_$(date +%F_%H%M).sql.gz
mkdir -p /home/clinicapp/clinic/backups
docker exec clinic-prod-db pg_dump -U clinic clinic_prod | gzip > $BK
echo " $BK"
find /home/clinicapp/clinic/backups -mtime +14 -delete

echo "== 拉代碼 =="
git pull

echo "🔍 Typecheck..."
docker exec app npx tsc --noEmit --project apps/web/tsconfig.json || {
  echo "❌ Typecheck 失敗，中止部署"; exit 1
}

echo "== 重建 app（migration 檔在映像裡，build 必須在 migrate 之前）=="
$DC up -d --build app

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

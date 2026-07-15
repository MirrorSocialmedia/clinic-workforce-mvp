#!/bin/bash
# Shift 完整性檢查 — 在 deploy.sh 的 migrate deploy 之後執行
# 如無 deploy.sh，手動在 server 端執行此腳本

echo "== Shift 完整性檢查 =="
BAD=$(docker exec clinic-prod-db psql -U clinic clinic_prod -tAc '
SELECT count(*) FROM "Shift"
WHERE ((("date" AT TIME ZONE '"'"'UTC'"'"') AT TIME ZONE '"'"'Asia/Hong_Kong'"'"')::date)
 <> ((("startTime" AT TIME ZONE '"'"'UTC'"'"') AT TIME ZONE '"'"'Asia/Hong_Kong'"'"')::date);' 2>/dev/null)

if [ $? -ne 0 ]; then
  echo "⚠️ 無法連接到 prod DB——跳過檢查"
elif [ "$BAD" != "0" ]; then
  echo "⚠️ 發現 $BAD 筆 date/startTime 不同日的 Shift——用完整性查詢列出並修復"
  exit 1
else
  echo " 0 筆異常 ✓"
fi

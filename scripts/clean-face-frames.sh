#!/bin/bash
# Clean face frames older than 30 days
# ★ 排除 ref_*.jpg —— 嗰啲係核准後永久保留嘅登記參考照（2026-07-29 決定），
# 同打卡證據幀放同一個目錄，唔排除就會被當成過期幀掃走。
docker exec $(docker ps -qf name=face) \
 find /data/frames -type f -name '*.jpg' ! -name 'ref_*' -mtime +30 -delete 2>/dev/null

# Clear faceFramePath in DB for old records
docker exec clinic-prod-db psql -U clinic clinic_prod -c \
 "UPDATE \"PunchRecord\" SET \"faceFramePath\" = NULL WHERE \"faceFramePath\" IS NOT NULL AND \"punchTime\" < now() - interval '30 days';" 2>/dev/null

echo "$(date '+%Y-%m-%d %H:%M:%S') Face frame cleanup completed" >> /tmp/face-cleanup.log

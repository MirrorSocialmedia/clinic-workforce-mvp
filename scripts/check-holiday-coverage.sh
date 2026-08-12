#!/usr/bin/env bash
set -euo pipefail
YEAR=$(date +%Y)
NEXT=$((YEAR + 1))
for Y in $YEAR $NEXT; do
 N=$(psql -U clinic -d clinic_prod -tAc \
 "SELECT count(*) FROM \"HKPublicHoliday\" WHERE EXTRACT(YEAR FROM date) = $Y;" 2>/dev/null || echo 0)
 if [ "$N" -lt 12 ]; then
 echo "❌ ${Y} 年公眾假期只有 ${N} 條（應該 17 條左右）—— 日薪分母會錯"
 exit 1
 fi
done
echo "✅ 公眾假期資料齊"

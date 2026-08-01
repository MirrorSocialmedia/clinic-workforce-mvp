#!/usr/bin/env bash
# check-duplicate-calc.sh
# 檢查業務計算有冇喺 route/component 內直接由原始資料砌
# 應該用 calculateTimeBank 或 matchPunchesToShifts
#
# 刻意嘅（例如 dashboard 即時概覽）加 // CALC-OK 豁免。

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 自己算遲到（應該用 calculateTimeBank 或 matchPunchesToShifts）==="
grep -rn "punchTime.*>.*startTime\|clockIn.*>.*shift" \
  apps/web/src/app/api apps/web/src/app/\(protected\) \
  --include=*.ts --include=*.tsx | grep -v "// CALC-OK" || true

echo ""
echo "=== 自己扣午飯（應該讀 config）==="
grep -rnE "3600000 - 1\b|3600000 - LUNCH|- 60 \* 60 \* 1000" \
  apps/web/src --include=*.ts --include=*.tsx | grep -v "// CALC-OK" || true

echo ""
echo "=== route 內直接 aggregate 業務表 ==="
grep -rn "timeBankEntry\.\(groupBy\|aggregate\)\|punchRecord\.\(groupBy\|aggregate\)" \
  apps/web/src/app/api --include=route.ts | grep -v "// AGG-OK" || true

echo ""
echo "=== 完成 ==="

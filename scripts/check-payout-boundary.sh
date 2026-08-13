#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# ★ Only check actual import lines (not comments)
HITS=$(grep -rn "^[[:space:]]*import\|^[[:space:]]*from" apps/web/src/lib/payout apps/web/src/lib/apricot 2>/dev/null \
  | grep -E "payroll-engine|calculateTimeBank|prisma\.employee|prisma\.payrollItem" || true)
if [ -n "$HITS" ]; then
 echo "❌ payout / apricot 模組唔准掂 clinic 內部："; echo "$HITS"; exit 1
fi
echo "✅ payout 邊界 OK"

#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
HITS=$(grep -rn "payroll-engine\|calculateTimeBank\|prisma\.employee\|prisma\.payrollItem" \
 apps/web/src/lib/payout apps/web/src/lib/apricot 2>/dev/null || true)
if [ -n "$HITS" ]; then
 echo "❌ payout / apricot 模組唔准掂 clinic 內部："; echo "$HITS"; exit 1
fi
echo "✅ payout 邊界 OK"

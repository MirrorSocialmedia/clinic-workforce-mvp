#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== check-catch-ignore.sh ==="

# Check P3 directories only (cost-entry, reconciliation, payout, api-client)
TARGETS=(
  "apps/web/src/lib/api-client.ts"
  "apps/web/src/app/(protected)/cost-entry"
  "apps/web/src/app/(protected)/reconciliation"
  "apps/web/src/app/(protected)/payout"
)

FOUND=0
for target in "${TARGETS[@]}"; do
  if grep -rn 'catch *{ */\* *ignore' "$target" --include='*.tsx' --include='*.ts' 2>/dev/null; then
    FOUND=1
  fi
done

if [ "$FOUND" -eq 1 ]; then
 echo "❌ 發現 catch { /* ignore */ }，唔准吞錯誤"
 exit 1
fi

echo "✅ check-catch-ignore.sh: 通過"
exit 0

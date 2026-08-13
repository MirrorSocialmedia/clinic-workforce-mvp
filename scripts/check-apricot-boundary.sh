#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
HITS=$(grep -rn "apricotvita" apps/web/src --include=*.ts --include=*.tsx \
 | grep -v "apps/web/src/lib/apricot/client.ts" || true)
if [ -n "$HITS" ]; then
 echo "❌ Apricot HTTP 只准喺 lib/apricot/client.ts："
 echo "$HITS"
 exit 1
fi
echo "✅ Apricot 邊界 OK"

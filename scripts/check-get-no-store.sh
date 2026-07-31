#!/usr/bin/env bash
# scripts/check-get-no-store.sh
# CI check: routes with write methods (PUT/PATCH/POST/DELETE) must have no-store in GET handler.
# Without this, browser may cache GET responses and show stale data after mutations.
set -euo pipefail

cd "$(dirname "$0")/.."

FAIL=0
for f in $(grep -rl "export async function \(PUT\|PATCH\|DELETE\|POST\)" apps/web/src/app/api --include=route.ts); do
  if grep -q "export async function GET" "$f" && ! grep -q "no-store\|jsonNoStore" "$f"; then
    echo "⚠️ $f：有寫入 method 但 GET 冇 no-store / jsonNoStore"
    FAIL=1
  fi
done

if [ "$FAIL" -eq 1 ]; then
  echo ""
  echo "❌ 部分 route 嘅 GET handler 缺少 no-store，操作成功後畫面可能唔更新"
  exit 1
fi

echo "✅ 所有有寫入 method 嘅 route，GET handler 都有 no-store / jsonNoStore"

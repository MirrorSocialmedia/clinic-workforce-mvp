#!/usr/bin/env bash
# CI check: flag hardcoded role checks that should use hasPermission instead.
# 刻意嘅檢查要喺同一行加 ROLE-OK 註釋（`// ROLE-OK` 或 `/* ROLE-OK */` 都得）。
set -euo pipefail

cd "$(dirname "$0")/.."

HITS=$(grep -rn "userRole === 'OWNER'\|role === 'OWNER'\|\.includes(user\?\?*\.role)" \
 apps/web/src/app apps/web/src/components \
 | grep -vE "ROLE-OK" \
 | grep -vE ":[0-9]+:[[:space:]]*(//|\*|\{/\*)" \
 || true)

if [ -n "$HITS" ]; then
 echo "❌ 前端 role 寫死（刻意的請在該行加 ROLE-OK 註釋）："
 echo "$HITS"
 exit 1
fi

echo "✅ 無 role 寫死問題"

#!/usr/bin/env bash
# scripts/check-role-hardcode.sh
# CI check: flag hardcoded role checks that should use hasPermission instead.
# Intentional checks must have `// ROLE-OK` on the same line.
set -euo pipefail

cd "$(dirname "$0")/.."

HITS=$(grep -rn "userRole === 'OWNER'\|role === 'OWNER'\|\.includes(user\?\?*\.role)" \
  apps/web/src/app apps/web/src/components \
  | grep -v "// ROLE-OK" || true)

if [ -n "$HITS" ]; then
  echo "❌ 前端 role 寫死（刻意的請在該行加 // ROLE-OK 註釋）："
  echo "$HITS"
  exit 1
fi

echo "✅ 無 role 寫死問題"

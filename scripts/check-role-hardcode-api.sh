#!/usr/bin/env bash
# scripts/check-role-hardcode-api.sh
# CI check: API routes with hardcoded role checks must have `// ROLE-OK` on the same line.
# Intentional role gates (e.g., OWNER-only payroll) are valid but must be documented.
set -euo pipefail

cd "$(dirname "$0")/.."

HITS=$(grep -rn "session\.role [!=]==\|session\.role ===\|auth\.session\.role [!=]==\|auth\.session\.role ===\|\.role !==\|\.role ===" \
  apps/web/src/app/api --include=route.ts \
  | grep -v "// ROLE-OK" \
  | grep -v "session\.role === 'KIOSK'" \
  | grep -v "session\.role === 'EMPLOYEE'" \
  | grep -v "session\.role === 'MANAGER'" \
  || true)

if [ -n "$HITS" ]; then
  echo "❌ API 內 role 寫死（刻意的請在該行加 // ROLE-OK 註釋）："
  echo "$HITS"
  exit 1
fi

echo "✅ 無 API role 寫死問題"

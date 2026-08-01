#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")/.."

# Detect hardcoded role comparisons:
#   role/userRole/session.role === or !== 'OWNER'|'MANAGER'|'ACCOUNTANT'|'EMPLOYEE'
# Scan: apps/web/src/app, apps/web/src/components
# Exempt paths: src/lib/permissions.ts, src/lib/auth.ts, src/app/api/auth/

HITS=$(grep -rnE \
  "(role|userRole|session\.role)\s*[!=]=[!=]?\s*'(OWNER|MANAGER|ACCOUNTANT|EMPLOYEE)'" \
  apps/web/src/app \
  apps/web/src/components \
  --include="*.ts" --include="*.tsx" \
  2>/dev/null \
  | grep -v "src/lib/permissions\.ts" \
  | grep -v "src/lib/auth\.ts" \
  | grep -v "src/app/api/auth/" \
  || true)

if [ -n "$HITS" ]; then
  echo "❌ Found hardcoded role comparisons:"
  echo "$HITS"
  exit 1
fi

echo "✅ No hardcoded role comparisons found"
exit 0

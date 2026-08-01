#!/usr/bin/env bash
set -uo pipefail

cd "$(dirname "$0")/.."

# Detect dynamic routes [id]/route.ts with findUnique/findFirst but no ownership guard.
# Ownership guards: clinicId | employeeId | assertOwnership | requireOwn | ownership-ok

SUSPECT=""

# find all route.ts under apps/web/src/app/api, then filter by [id] in path
while IFS= read -r filepath; do
  [ -z "$filepath" ] && continue

  # Must contain findUnique or findFirst
  grep -qE "findUnique|findFirst" "$filepath" 2>/dev/null || continue

  # If file has any ownership guard keyword, skip
  grep -qE "clinicId|employeeId|assertOwnership|requireOwn|ownership-ok" "$filepath" 2>/dev/null && continue

  SUSPECT="${SUSPECT}${filepath}
"

done < <(find apps/web/src/app/api -type f -name "route.ts" 2>/dev/null | grep '\[id\]' | sort)

if [ -n "$SUSPECT" ]; then
  echo "❌ Dynamic routes with findUnique/findFirst but NO ownership guard:"
  echo -n "$SUSPECT"
  exit 1
fi

echo "✅ All dynamic routes have ownership guards"
exit 0

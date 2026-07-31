#!/usr/bin/env bash
# scripts/check-rbac-matrix.sh
# CI check: routes using requireAuth must have a corresponding key in RBAC_MATRIX.
# Without this, new routes will get 403 "route not registered" errors.
set -euo pipefail

cd "$(dirname "$0")/.."

# Extract all route patterns from requireAuth calls in API route files
MISSING=0
CONFIG_FILE="apps/web/src/lib/config.ts"

# Get all normalized route keys from config
if [ ! -f "$CONFIG_FILE" ]; then
  echo "⚠️ $CONFIG_FILE not found, skipping"
  exit 0
fi

# Find routes using requireAuth and check they're in the matrix
for f in $(grep -rl "requireAuth" apps/web/src/app/api --include=route.ts); do
  # Extract the route path from the file location
  # apps/web/src/app/api/foo/bar/route.ts → /api/foo/bar
  route=$(echo "$f" | sed 's|apps/web/src/app/api/||;s|/route.ts$||' | sed 's|/\[.*\]|/:id|g; s|/\[.*\]|/:id|g')
  
  # Check common HTTP methods
  for method in GET POST PUT PATCH DELETE; do
    key="$method /api/$route"
    if grep -q "requireAuth" "$f"; then
      if ! grep -q "\"$key\"" "$CONFIG_FILE" && ! grep -q "'$key'" "$CONFIG_FILE"; then
        # Check with escaped colons for grep
        if ! grep -qF "$key" "$CONFIG_FILE"; then
          echo "⚠️ $f：requireAuth 但 RBAC_MATRIX 冇 \"$key\" key"
          MISSING=1
        fi
      fi
    fi
  done
done

if [ "$MISSING" -eq 1 ]; then
  echo ""
  echo "❌ 部分 route 未登記 RBAC matrix"
  exit 1
fi

echo "✅ 所有 requireAuth route 都喺 RBAC matrix 有登記"

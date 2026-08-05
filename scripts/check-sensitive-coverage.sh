#!/bin/bash
# 逼每個自訂 audit action 表態：敏感（SPEC）或明確豁免（EXEMPT）
# EXEMPT 名單直接讀 sensitive-audit.ts，避免兩份不同步
set -e

BASE=$(git rev-parse --show-toplevel)
SPEC_FILE="$BASE/apps/web/src/lib/sensitive-audit.ts"

# Read EXEMPT values from the TS file (skip the variable name itself)
EXEMPT=$(sed -n "/SENSITIVE_AUDIT_EXEMPT/,/^[)]/p" "$SPEC_FILE" 2>/dev/null \
  | grep -o "'[A-Z][A-Z_]*'" 2>/dev/null \
  | tr -d "'" \
  | paste -sd'|' -)

# Read SPEC action values
SPEC=$(grep -oP "action: '\K[A-Z_]+" "$SPEC_FILE" 2>/dev/null | sort -u)

# Read ALL action values from codebase, excluding sensitive-audit.ts itself
ALL=$(grep -rhoP "action: '\K[A-Z_]+" \
  "$BASE/apps/web/src/app/api" \
  "$BASE/apps/web/src/lib" \
  2>/dev/null \
  | grep -v "sensitive-audit" \
  | sort -u)

# Filter out exempt actions
if [ -n "$EXEMPT" ]; then
  ALL=$(echo "$ALL" | grep -v -E "^($EXEMPT)$" || true)
  ALL=$(echo "$ALL" | grep -v '^$' | sort -u)
fi

MISS=0
for a in $ALL; do
  [ -z "$a" ] && continue

  # Check if in SPEC
  if echo "$SPEC" | grep -qx "$a"; then
    continue
  fi

  # CREATE, UPDATE, DELETE are entity-based — covered separately
  if [[ "$a" == "CREATE" || "$a" == "UPDATE" || "$a" == "DELETE" ]]; then
    continue
  fi

  echo "❌ 未分類 audit action: $a — 加入 SENSITIVE_AUDIT_SPEC 或 SENSITIVE_AUDIT_EXEMPT"
  MISS=1
done

if [ $MISS -eq 0 ]; then
  echo "✅ All audit actions classified"
fi
exit $MISS

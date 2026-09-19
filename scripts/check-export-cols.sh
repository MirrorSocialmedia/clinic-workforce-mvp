#!/usr/bin/env bash
# ★ cwm-exportcols-regress-20260919：EXPORT_COLS 每個 key 都要喺 pick() 有對應 case，
#   否則剔咗會出空白（default: return ''）；反之 pick() 有而 EXPORT_COLS 冇 = 永遠出唔到。
set -euo pipefail
cd "$(dirname "$0")/.."
COLS="apps/web/src/lib/payroll-export-cols.ts"
ROUTE="apps/web/src/app/api/payroll-runs/[id]/export/route.ts"
FAIL=0
for k in $(grep -oE "key: '[a-zA-Z]+'" "$COLS" | sed "s/key: '\(.*\)'/\1/"); do
  grep -q "case '$k':" "$ROUTE" || { echo "❌ EXPORT_COLS 有 '$k' 但 pick() 冇 case → 剔咗會出空白"; FAIL=1; }
done
for k in $(grep -oE "case '[a-zA-Z]+':" "$ROUTE" | sed "s/case '\(.*\)':/\1/"); do
  grep -q "key: '$k'" "$COLS" || { echo "❌ pick() 有 '$k' 但 EXPORT_COLS 冇 → 永遠出唔到"; FAIL=1; }
done
[ "$FAIL" = 0 ] && echo "OK"
exit $FAIL

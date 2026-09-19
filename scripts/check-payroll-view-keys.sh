#!/usr/bin/env bash
# ★ cwm-exportcols-regress-20260919：前端卡／欄選項一定要喺後端白名單入面，
#   否則用戶剔完儲存會被靜靜隔走（總 MPF 卡就係咁，用戶以為個掣壞咗）。
set -euo pipefail
cd "$(dirname "$0")/.."
FE="apps/web/src/app/(protected)/payroll/[id]/page.tsx"
BE="apps/web/src/app/api/companies/[id]/route.ts"
FAIL=0
for k in $(sed -n "/^const CARD_OPTIONS/,/^]/p;/^const COL_OPTIONS/,/^]/p" "$FE" \
            | grep -oE "key: '[a-zA-Z]+'" | sed "s/key: '\(.*\)'/\1/" | sort -u); do
  grep -q "'$k'" "$BE" || { echo "❌ 前端有 '$k' 但後端白名單冇 —— 儲存會被隔走"; FAIL=1; }
done
[ "$FAIL" = 0 ] && echo "OK"
exit $FAIL

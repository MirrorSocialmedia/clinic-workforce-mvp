#!/usr/bin/env bash
# ★ cwm-payrollsheet-20260921：匯出／總表讀 detailJson.xxx，引擎一定要有寫 xxx。
#   否則靜靜出 0（津貼／折現／超額休息日就係咁壞咗幾個月都冇人知）。
#
# ★ 2026-09-22 [payrollsheet S1] 三層檢查（鐵律 #4：讀 key 先 grep 引擎核對寫入層）：
#   L1 底層：reader 讀嘅 key 引擎任何位置都要有寫入（防「完全冇寫」— e.g. 舊 excessRestDeduction）。
#   L2 resignSettlement region：reader 讀 detail.resignSettlement?.key →
#      引擎 `resignSettlement: rsSettle ? {...}` 物件字面量【入面】要真係有 key:
#      （L1 全檔 grep 會俾 options 組裝行（:1154 rsRow 讀取）誤判成「有寫」— 呢層補盲點）。
#   L3 NESTED_KEYS 禁 top-level：引擎只寫喺 block 入面嘅 key，reader 唔准讀 top-level detail.<key>
#      （tbCashout 就係引擎寫咗但位置喺 resignSettlement 入面，舊 export 讀 top-level → 永遠 0）。
set -euo pipefail
ENGINE="apps/web/src/lib/payroll-engine.ts"
READERS=(
  "apps/web/src/app/api/payroll-runs/[id]/export/route.ts"
  "apps/web/src/app/api/payroll-runs/[id]/route.ts"
  "apps/web/src/app/api/payroll-runs/cheque-sheet/route.ts"
)
FAIL=0

# 引擎 resignSettlement 物件字面量區域（`resignSettlement: rsSettle ? {` → `} : undefined,`）
RS_REGION=""
rs_start=$(grep -n 'resignSettlement: rsSettle ? {' "$ENGINE" | head -1 | cut -d: -f1 || true)
if [ -n "$rs_start" ]; then
  RS_REGION=$(awk -v s="$rs_start" 'NR>=s { print; if (NR>s && /} : undefined,/) exit }' "$ENGINE")
fi

for f in "${READERS[@]}"; do
  [ -f "$f" ] || continue

  # ── L1 底層：detail.xxx 同 detail.resignSettlement?.xxx 兩種 ──
  for k in $(grep -oE "detail\.(resignSettlement\?\.)?[a-zA-Z]+" "$f" | sed -E 's/detail\.(resignSettlement\?\.)?//' | sort -u); do
    grep -qE "^\s+${k}\s*:|[{,]\s*${k}\s*[,}]|\b${k}\s*,\s*$" "$ENGINE" \
      || { echo "❌ $f 讀 detail.$k，但 payroll-engine.ts 冇寫呢個 key"; FAIL=1; }
  done

  # ── L2 resignSettlement region：nested 讀取要喺字面量入面真係有寫 ──
  if [ -n "$RS_REGION" ]; then
    for k in $(grep -oE "detail\.resignSettlement\??\.[a-zA-Z]+" "$f" | sed -E 's/^detail\.resignSettlement\??\.//' | sort -u); do
      if ! printf '%s\n' "$RS_REGION" | grep -qE "^\s*${k}\s*:"; then
        echo "❌ $f 讀 detail.resignSettlement?.$k，但引擎 resignSettlement 字面量冇寫 $k"
        FAIL=1
      fi
    done
  fi

  # ── L3 NESTED_KEYS：禁 top-level 讀取 ──
  #   引擎只寫喺 block 入面嘅 key（key:block）。reader 若讀 top-level detail.<key> → 永遠 0。
  #   ⚠️ 引擎加新 nested 寫入時，要喺呢度加一列。
  NESTED_KEYS=(
    "annualLeavePay:resignSettlement"
    "noticePay:resignSettlement"
    "tbDeduction:resignSettlement"
    "tbCashout:resignSettlement"
    "excessRestDeduction:resignSettlement"
    "grossAdd:resignSettlement"
    "includedInMpf:resignSettlement"
    "monthWage:resignSettlement"
  )
  for k in $(grep -oE "detail\.[a-zA-Z]+" "$f" | sed 's/^detail\.//' | sort -u); do
    for nk in "${NESTED_KEYS[@]}"; do
      nkkey="${nk%%:*}"
      if [ "$k" = "$nkkey" ]; then
        echo "❌ $f 讀 top-level detail.$k — 但引擎只寫喺 ${nk##*:} 入面（正確寫法: detail.${nk##*:}?.$nkkey）"
        FAIL=1
      fi
    done
  done
done
[ "$FAIL" = 0 ] && echo "OK"
exit $FAIL

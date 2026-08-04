#!/usr/bin/env bash
# LeaveBalance 嘅 year 唔可以直接用 getFullYear —— 要用 balanceYearFor()
# 檢查有冇 LeaveBalance 查詢直接用曆年而冇經 balanceYearFor()

cd "$(dirname "$0")/.."

FOUND=0

# 檢查有冇 LeaveBalance 查詢直接用 getUTCFullYear 或 getFullYear
grep -rn "leaveBalance" apps/web/src/app/api --include=route.ts -B 5 -A 5 \
  | grep -E "year.*getUTCFullYear|year.*getFullYear" \
  && FOUND=1

# 檢查有冇 year: new Date().getUTCFullYear() 直接寫入 LeaveBalance
grep -rn "year: new Date().getUTCFullYear()" apps/web/src/app/api --include=route.ts \
  && FOUND=1

if [ $FOUND -eq 1 ]; then
  echo "⚠️ 有 LeaveBalance 查詢直接用曆年，冇經 balanceYearFor()"
  exit 1
fi

echo "✅ 所有 LeaveBalance 查詢都經 balanceYearFor()"
exit 0

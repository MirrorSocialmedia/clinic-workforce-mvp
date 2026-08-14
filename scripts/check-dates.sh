#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

FAIL=0

echo "=== check-dates.sh ==="

# 已知 pre-existing 問題（唔屬於呢個 task 嘅範圍）
PREEXISTING=(
  "employees/[id]/overview/route.ts"
  "employees/[id]/overview/history/route.ts"
  "lib/sick-leave-quota.ts"
)

# 有意義豁免：Excel serial number 轉換本身就係 UTC 基準，唔涉 HK 時區
# parsePaymentReport.ts 將 Excel 嘅 serial date (1900-era) 轉為 JS Date，
# 呢個轉換過程必然涉及 UTC，但佢處理嘅係數值而非「HK 時區日期」，
# 因此屬有意義豁免，唔同 pre-existing 問題混在一起。
INTENTIONAL_EXEMPT=(
  "lib/reconciliation/parsePaymentReport.ts"
)

# 合併做 SKIP_FILES
SKIP_FILES=("${PREEXISTING[@]}" "${INTENTIONAL_EXEMPT[@]}")

should_skip() {
  local f="$1"
  for skip in "${SKIP_FILES[@]}"; do
    [[ "$f" == *"$skip"* ]] && return 0
  done
  return 1
}

# 檢查 api/lib 中所有 TS 檔案是否正確處理時區
for f in $(find apps/web/src/app/api apps/web/src/lib -name '*.ts' -not -path '*/node_modules/*' 2>/dev/null); do
  # 跳過已知 pre-existing 問題
  if should_skip "$f"; then
    continue
  fi

 # 1. 檢查 .toISOString().split('T') —— 應該用 toHKDateStr 代替
 if grep -n '\.toISOString()\.split' "$f" 2>/dev/null | grep -v 'toHKDateStr\|hkDateStart\|hkDateEnd'; then
 echo "⚠️ $f: toISOString().split('T') 可能用 UTC 日期，應改用 toHKDateStr"
 FAIL=1
 fi
 # 2. 檢查 new Date(\`...\-31T...) —— 應該用 monthRange
 if grep -n 'new Date.*-31T' "$f" 2>/dev/null; then
 echo "⚠️ $f: 寫死 -31 做月尾，應改用 monthRange()"
 FAIL=1
 fi
 # 3. 檢查 .getMonth() 用於日期比較/查詢（排除格式化 + 已知安全模式）
 if grep -n '\.getMonth()' "$f" 2>/dev/null | grep -v '\.getMonth() [+].*1\|getMonth()+1\|getCurrentMonth'; then
 echo "⚠️ $f: 使用 .getMonth()，建議改用 hkDateStr"
 FAIL=1
 fi
done

# 4. 檢查 prisma 查询中使用 createdAt / updatedAt / paidAt 等日期字段时是否应用了正确的时区处理
# 此为 info 级别，不导致失败
FOUND=0
for f in $(find apps/web/src/app/api apps/web/src/lib -name '*.ts' -not -path '*/node_modules/*' 2>/dev/null); do
 if grep -n 'createdAt.*gte\|updatedAt.*gte\|paidAt.*gte' "$f" 2>/dev/null; then
 FOUND=1
 fi
done
if [ "$FOUND" -eq 1 ]; then
 echo "ℹ️ 以上檔案使用日期查詢，請確認使用 hkDateStart/hkDateEnd"
fi

if [ "$FAIL" -ne 0 ]; then
 echo "❌ check-dates.sh: 發現潛在時區問題"
 exit 1
fi

echo "✅ check-dates.sh: 通過"
exit 0

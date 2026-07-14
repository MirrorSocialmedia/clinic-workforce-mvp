#!/bin/bash
# 時區守則自動檢查 — CI 守門腳本
# 檢查所有 src 下的 .ts/.tsx 文件（排除 hk-date.ts 本身）
set -e

cd "$(dirname "$0")/.."

FAIL=0

check() {
  local desc="$1"; shift
  local hits
  hits=$(grep -rn "$@" src --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v "hk-date.ts" || true)
  hits=$(echo "$hits" | grep -v '+08:00' | grep -v 'timeZone' | grep -v 'tz-ok' | grep -v '^$' || true)
  if [ -n "$hits" ]; then
    echo "❌ $desc"
    echo "$hits" | head -20
    FAIL=1
  else
    echo "✅ $desc"
  fi
}

check "組時間字串必帶 +08:00" 'T\${time}'
check "組日界字串必帶 +08:00" 'T00:00:00\`'
check "toLocale 必帶 timeZone" "toLocaleTimeString('zh-HK'\|toLocaleDateString('zh-HK'\|toLocaleString('zh-HK'"
check "禁用 setHours" "setHours("
check "禁用 toISOString slice 當日期鍵" "toISOString().slice(0, 10)\|toISOString().slice(0, 7)"

exit $FAIL

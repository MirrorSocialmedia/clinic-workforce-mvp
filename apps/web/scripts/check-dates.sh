#!/bin/bash
# 時區守則自動檢查 — CI 守門腳本
# 檢查所有 src 下的 .ts/.tsx 文件
# 豁免：getUTC 開頭的純 UTC 數學、+08:00 字串、timeZone 選項、tz-ok 註釋
set -e

cd "$(dirname "$0")/.."

FAIL=0

check() {
  local desc="$1"; shift
  local hits
  hits=$(grep -rn "$@" src --include="*.ts" --include="*.tsx" 2>/dev/null | grep -v 'getUTC' || true)
  hits=$(echo "$hits" | grep -v '+08:00' | grep -v 'timeZone' | grep -v '\.\.\.HK' | grep -v 'tz-ok' | grep -v '^$' || true)
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
check "禁用本機時區日曆運算" "\.getMonth()\|\.getFullYear()\|\.getDate()\|\.getDay()\|setFullYear(\|setDate(\|new Date([a-z_]\+, [a-z_]"

# Positive assertion: shift-write helper must exist and contain required patterns
assert() {
  local desc="$1"; shift
  local hits
  hits=$(grep -rn "$@" src 2>/dev/null | grep -v '^$' || true)
  if [ -n "$hits" ]; then
    echo "✅ $desc"
  else
    echo "❌ $desc (pattern not found)"
    FAIL=1
  fi
}

assert "Shift 三欄只准經 shift-write helper 組裝" "startTime: new Date\|date: hkDateStart" "lib/shift-write.ts"

exit $FAIL

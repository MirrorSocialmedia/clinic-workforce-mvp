#!/usr/bin/env bash
# Regressions guard: verify payroll API routes compile and don't have obvious issues
# 2026-08-09: deploy 前檢查 payroll 相關 routes
set -euo pipefail
cd "$(dirname "$0")/.."

check_route() {
  local route="$1"
  local found
  found=$(find apps/web/src/app/api -name "route.ts" -path "*${route#api}*" 2>/dev/null | head -1)
  if [ -z "$found" ]; then
    echo "⚠️ 搵唔到 route: $route"
    return 1
  fi
  # Check for silent catches (catch {} without console.error)
  if grep -Pzo '\}\s*catch\s*\{\s*\}' "$found" > /dev/null 2>&1; then
    echo "⚠️ silent catch 發現: $found ($route)"
    return 1
  fi
  echo "✅ $route OK"
}

echo "🔍 檢查 payroll routes..."
fail=0

check_route "/api/payroll-runs" || fail=1
check_route "/api/payroll-runs/exceptions" || fail=1
check_route "/api/payroll-runs/allowed-clinics" || fail=1
check_route "/api/timebank" || fail=1
check_route "/api/leave-requests" || fail=1

if [ "$fail" = "1" ]; then
  echo ""
  echo "❌ payroll routes 檢查失敗，請修復後再 deploy。"
  exit 1
else
  echo ""
  echo "✅ 所有 payroll routes 檢查通過。"
  exit 0
fi

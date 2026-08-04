#!/usr/bin/env bash
# 涉及金額/假期/權限的寫入 route 必須有 auditLog
# 2026-08-04: deploy 前檢查 —— 捉審計缺口
set -euo pipefail
cd "$(dirname "$0")/.."

found=0
for f in $(grep -rl "prisma\.\(payRule\|wageHistory\|leaveBalance\|payrollItem\)\.\(update\|create\|delete\|upsert\)" \
    apps/web/src/app/api --include=route.ts 2>/dev/null); do
  # 排除已知免審計的 route
  case "$f" in
    *refresh*) continue ;;  # auto-recalculate, not manual
    *convert*) continue ;;  # timebank convert has its own audit via Prisma extension
  esac
  grep -q "auditLog" "$f" || { echo "⚠️ 缺審計：$f"; found=1; }
done

if [ "$found" = "1" ]; then
  echo ""
  echo "❌ 發現缺審計的 route，請補齊後再 deploy。"
  exit 1
else
  echo "✅ 所有涉及金額/假期的寫入 route 都有 auditLog。"
  exit 0
fi

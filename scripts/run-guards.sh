#!/bin/bash
# 部署守門：deploy.sh 同 CI 共用同一份清單，避免兩邊漂移。
# 用法：喺 repo 根目錄 `bash scripts/run-guards.sh`
# 一次過跑晒全部，列出所有失敗（唔會第一個失敗就停），有任何失敗 exit 1。
set -u
cd "$(git rev-parse --show-toplevel)"
CHECKS="check-rbac-matrix.sh check-role-hardcode.sh check-role-hardcode-api.sh \
 check-ownership.sh check-sensitive-coverage.sh check-audit-coverage.sh \
 check-duplicate-calc.sh check-get-no-store.sh check-balance-year.sh \
 check-apricot-boundary.sh check-payout-boundary.sh check-pii.sh check-dates.sh \
 check-company-scope.sh check-holiday-coverage.sh check-payroll-surface.sh check-catch-ignore.sh \
 check-export-cols.sh check-payroll-view-keys.sh check-detail-keys.sh"
FAILED=""
for script in $CHECKS; do
  [ -f "scripts/$script" ] || continue
  echo "▶ $script"
  bash "scripts/$script" || { echo "❌ $script failed"; FAILED="$FAILED $script"; }
done
if [ -n "$FAILED" ]; then
  echo "❌ 守門未過：$FAILED"
  exit 1
fi
echo "✅ 全部守門通過"

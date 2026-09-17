#!/usr/bin/env bash
# ★ cwm-companyscope-20260917：防止再有人喺 scope-helpers 度加多 return null
# （null = 全系統，跨公司）。合法 return null 只有 3 個：
# resolveClinicScope OWNER / resolveAccessibleCompanyIds OWNER / getConfidentialScope OWNER
set -euo pipefail
F="apps/web/src/lib/scope-helpers.ts"
N=$(grep -c "return null" "$F" || true)
if [ "$N" -gt 3 ]; then
  echo "❌ scope-helpers.ts 有 $N 個 return null（只准 3 個合法 OWNER 分支）"
  echo " ⚠️ null = 全系統零 filter，會跨公司。用 getOwnCompanyClinicIds 代替。"
  exit 1
fi
echo "OK: scope-helpers.ts return null = $N (≤3)"

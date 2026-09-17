#!/usr/bin/env bash
# ★ cwm-companyscope-20260917：MANAGER 嘅【薪金類】範圍一定要收窄到同公司。
# 剷走呢句 = 臻善經理再次睇到匯樂／菁薈嘅計糧單。
set -euo pipefail
F="apps/web/src/lib/scope-helpers.ts"
grep -q "getOwnCompanyClinicIds(session.userId)" "$F" || {
 echo "❌ scope-helpers.ts 冇咗 getOwnCompanyClinicIds —— MANAGER 會跨公司睇計糧"; exit 1; }
grep -q "if ((forPerms.companyWide?.length ?? 0) > 0) return null" "$F" || {
 echo "❌ MANAGER 嘅 companyWide 分支唔見咗 —— 排班／打卡會限死喺同公司"; exit 1; }
echo "OK"

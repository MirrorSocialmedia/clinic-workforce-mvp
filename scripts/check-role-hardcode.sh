#!/usr/bin/env bash
# CI check: 偵測應該用 hasPermission 而唔係 role 比較嘅地方。
#
# 豁免方式（三選一）：
#   ① 同一行加 `// ROLE-OK: 理由` 或 `/* ROLE-OK: 理由 */`
#   ② 檔案喺 EXEMPT_PATHS 內（權限系統本身、角色路由）
#   ③ 純註釋行自動跳過
set -uo pipefail

cd "$(dirname "$0")/.."

HITS=$(grep -rnE \
  "(role|userRole|session\.role)\s*[!=]=[!=]?\s*'(OWNER|MANAGER|ACCOUNTANT|EMPLOYEE)'" \
  apps/web/src/app \
  apps/web/src/components \
  --include="*.ts" --include="*.tsx" \
  2>/dev/null \
  | grep -v "src/lib/permissions\.ts" \
  | grep -v "src/lib/auth\.ts" \
  | grep -v "src/app/api/auth/" \
  `# ★ 角色路由 —— 決定「去邊一頁 / 顯示邊個版面」，唔係權限 gate` \
  | grep -v "src/app/login/page\.tsx" \
  | grep -v "src/app/page\.tsx" \
  | grep -v "src/app/(protected)/layout\.tsx" \
  `# ★ 已標註刻意（同一行 // ROLE-OK 或 /* ROLE-OK */）` \
  | grep -vE "ROLE-OK" \
  `# ★ 純註釋行（行號之後第一個非空白係 // 或 * 或 {/*）` \
  | grep -vE ":[0-9]+:[[:space:]]*(//|\*|\{/\*)" \
  `# ★ form.role 係表單入面揀角色，唔係當前用戶角色判斷` \
  | grep -v "form\.role" \
  || true)

if [ -n "$HITS" ]; then
  echo "❌ Found hardcoded role comparisons（刻意嘅請加 // ROLE-OK: 理由）："
  echo "$HITS"
  exit 1
fi

echo "✅ No hardcoded role comparisons found"
exit 0

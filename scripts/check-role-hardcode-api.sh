#!/usr/bin/env bash
# CI check: API routes with hardcoded role checks must be documented with ROLE-OK.
# 註釋可以喺同一行，或者緊接嘅上一行。
set -euo pipefail

cd "$(dirname "$0")/.."

# ★ 只 match session/auth.session/user 嘅 role —— 唔好用獨立嘅 `\.role !==`，
# 佢會捉到 Shift.role（更次崗位）呢類完全無關嘅欄位。
PATTERN="session\.role [!=]==\|auth\.session\.role [!=]==\|user\.role [!=]=="

# ★ -B1 令上一行嘅 ROLE-OK 都算數 —— API route 嘅 role gate
# 通常喺 if 上面寫理由，強制同一行唔自然。
HITS=$(grep -rn -B1 "$PATTERN" apps/web/src/app/api --include=route.ts \
 | awk '
 /ROLE-OK/ { skip=1; next }
 /^--$/ { skip=0; next }
 {
  if (skip) { skip=0; next }
  # 只保留 grep -n 出嚟嘅命中行（file:line:），跳過 -B1 嘅上下文行（file-line-）
  if ($0 ~ /^apps.*\.ts:[0-9]+:/) print
 }
 ' \
 | grep -v "session\.role === 'KIOSK'" \
 | grep -v "session\.role === 'EMPLOYEE'" \
 | grep -v "session\.role === 'MANAGER'" \
 || true)

if [ -n "$HITS" ]; then
 echo "❌ API 內 role 寫死（刻意的請在該行或上一行加 ROLE-OK 註釋）："
 echo "$HITS"
 exit 1
fi

echo "✅ 無 API role 寫死問題"

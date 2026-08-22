#!/usr/bin/env bash
# 唔 exit 1 —— 有啲 route 特意冇 caller（cron / 一次性 script）
set -uo pipefail
cd "$(dirname "$0")/.."
SRC=apps/web/src

echo "=== API route 零前端 caller ==="
for f in $(find $SRC/app/api -name route.ts); do
 p=${f#$SRC/app}; p=${p%/route.ts}
 pat=$(echo "$p" | sed 's|\[[^]]*\]|[^"`/]*|g')
 n=$(grep -rlE "\"$pat|\`$pat|'$pat" $SRC --include=*.tsx --include=*.ts 2>/dev/null | grep -v "/api/" | wc -l)
 [ "$n" -eq 0 ] && echo " $p"
done

echo "=== Page 冇入口 ==="
for f in $(find "$SRC/app/(protected)" -name page.tsx); do
 p=${f#$SRC/app/\(protected\)}; p=${p%/page.tsx}
 [ -z "$p" ] && continue
 case "$p" in *"["*) continue;; esac
 n=$(grep -rl "\"$p\"\|'$p'\|\`$p\`" $SRC --include=*.tsx 2>/dev/null | wc -l)
 [ "$n" -eq 0 ] && echo " $p"
done

# ★ 2026-08-22（cw-patwk）：明確 exit 0 —— 上面最後一個 `[ ... ] && echo` 喺
#   冇 entry 嘅 page 會令 script 意外 exit 1（同 header「唔 exit 1」意圖矛盾，
#   baseline 5b19e94f 已驗證同一 leak）。純資訊輸出，唔係 gate。
exit 0

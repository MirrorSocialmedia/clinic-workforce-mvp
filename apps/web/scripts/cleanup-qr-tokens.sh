#!/bin/bash
# QR token 清理 —— lib/qr-token.ts 的 cleanupExpiredTokens/purgeOldUsedTokens
# 写好咗但一直冇 caller，令 QRToken 表只增不减。
#
# 两段语义唔同：
# ① 过期而且【冇人用过】→ 即刻删（冇证据价值）
# ② 90 日前的（含已用）→ 删；QRTokenUsage 有 onDelete: Cascade，
# 所以呢步会连"边个几时用了边个码"的证据一起抹走 —— 90 日系刻意的保留期。

docker exec clinic-prod-db psql -U clinic clinic_prod -c \
 "DELETE FROM \"QRToken\" t
 WHERE t.\"expiresAt\" < now()
 AND NOT EXISTS (SELECT 1 FROM \"QRTokenUsage\" u WHERE u.\"tokenId\" = t.id);" 2>/dev/null

docker exec clinic-prod-db psql -U clinic clinic_prod -c \
 "DELETE FROM \"QRToken\" WHERE \"expiresAt\" < now() - interval '90 days';" 2>/dev/null

echo "$(date '+%Y-%m-%d %H:%M:%S') QR token cleanup completed" >> /tmp/qr-cleanup.log

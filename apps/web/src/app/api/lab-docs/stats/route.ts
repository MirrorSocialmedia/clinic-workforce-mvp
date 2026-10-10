// ★ cwm-labdoc P4 CHUNK 3：GET /api/lab-docs/stats — §11 容量＋各狀態數量（lab_statement）
//
// 回傳：
//   - totalBytes / fileCount：LabFile 聚合（未 purge — 碟上實際佔用）
//   - docCount / statusCounts：LabDocument 各狀態數量（§12.6 設定頁「容量統計」）
// 容量口徑（§5）：每日約 30 張 × 0.6MB ≈ 18MB/日、7 年 ≈ 45GB — 設定頁顯示作參考基線
// 權限：lab_statement（§11）— lab_invoice 403（RBAC_MATRIX + RBAC_PERM_OVERRIDES 雙登記）
// ownership-ok: 聚合統計（零行級數據、零姓名）
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { jsonNoStore } from '@/lib/api-response'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { perms } = auth
  if (!(perms ?? []).includes('lab_statement')) {
    return jsonNoStore({ error: '需要 lab_statement 權限' }, { status: 403 })
  }

  // LabFile：碟上佔用（未 purge 先算；purge 後 size 歸零）
  const fileAgg = await prisma.labFile.aggregate({
    where: { purgedAt: null },
    _sum: { sizeBytes: true },
    _count: { _all: true },
  })
  // LabDocument：各狀態數量（全狀態 — 設定頁顯示生命週期分佈）
  const statusGroups = await prisma.labDocument.groupBy({
    by: ['status'],
    _count: { _all: true },
  })

  const statusCounts: Record<string, number> = {}
  for (const g of statusGroups) statusCounts[g.status] = g._count._all

  return jsonNoStore({
    totalBytes: fileAgg._sum.sizeBytes ?? 0,
    fileCount: fileAgg._count._all,
    docCount: Object.values(statusCounts).reduce((a, b) => a + b, 0),
    statusCounts,
  })
}

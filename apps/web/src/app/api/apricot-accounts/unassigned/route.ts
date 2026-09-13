// ★ cwm-apricotacct-20260913 E1：GET /api/apricot-accounts/unassigned
// 「未綁帳號」清單 — 有收入但冇綁任何個體（或只標咗 UNKNOWN）嘅 Apricot 帳號。
//
// ⚠️ `kind <> 'UNKNOWN'` —— 標咗 UNKNOWN 嘅**仍然會出**（提醒你佢仲收緊錢），
//    但前端灰色低調顯示。
// ★ RBAC：OWNER only（config.ts MATRIX，零 RBAC_PERM_OVERRIDES）
export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { handleRoute } from '@/lib/api-guard'
import { jsonNoStore } from '@/lib/api-response'
import { prisma } from '@/lib/prisma'

interface UnassignedRow {
  apricotId: string
  name: string | null
  allocCount: number
  amount: string | null
  firstMonth: string | null
  lastMonth: string | null
  clinics: string[] | null
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  return handleRoute('apricot-accounts/unassigned', async () => {
    // ★ MD 逐字 SQL — 唔好改語義（NOT EXISTS 用 kind <> 'UNKNOWN'）
    const rows = await prisma.$queryRaw<UnassignedRow[]>`
      SELECT pa."providerExtId"                             AS "apricotId",
             -- ★ cwm-unassigned-fix-20260913 ①：用 subquery 唔用 JOIN。
             --   JOIN "ApricotBill" ON providerExtId 係 1 對多 → COUNT/SUM 會被乘以單數
             --   （實測：2 筆 × 5 張單 = 10 筆、$580 × 5 = $2,900）。
             (SELECT ab."providerName"
                FROM "ApricotBill" ab
               WHERE ab."providerExtId" = pa."providerExtId"
                 AND ab."providerName" IS NOT NULL
               ORDER BY ab."billTime" DESC
               LIMIT 1)                                      AS name,
              COUNT(*)::int                                   AS "allocCount",
              SUM(pa.amount)                                  AS amount,
              MIN(pa."periodMonth")                           AS "firstMonth",
              MAX(pa."periodMonth")                           AS "lastMonth",
              ARRAY_AGG(DISTINCT c.name) FILTER (WHERE c.name IS NOT NULL)  AS clinics
      FROM "PaymentAllocation" pa
      LEFT JOIN "Clinic"      c  ON c."apricotClinicId" = pa."clinicExtId"
      WHERE pa."isVoid" = false AND pa."isSuperseded" = false
        -- ★ ②：金額 0 冇資訊價值，只會令清單有噪音（實測有一筆 $0 / methodNorm=UNKNOWN）
        AND pa.amount > 0
        AND NOT EXISTS (
          SELECT 1 FROM "ApricotPractitioner" ap
          WHERE ap."apricotId" = pa."providerExtId" AND ap.kind <> 'UNKNOWN'
        )
      GROUP BY 1 ORDER BY SUM(pa.amount) DESC
    `

    // ★ kind 狀態：完全冇行 = UNBOUND；有行但全部 UNKNOWN = MARKED_UNKNOWN（灰色低調顯示）
    const ids = rows.map(({ apricotId }) => apricotId).filter(Boolean)
    const kindRows = ids.length > 0
      ? await prisma.apricotPractitioner.findMany({
          where: { apricotId: { in: ids } },
          select: { apricotId: true, kind: true },
        })
      : []
    const kindsByApId = new Map<string, Set<string>>()
    for (const { apricotId: kId, kind: kKind } of kindRows) {
      if (!kindsByApId.has(kId)) kindsByApId.set(kId, new Set())
      kindsByApId.get(kId)!.add(kKind)
    }

    const list = rows
      .filter(({ apricotId }) => Boolean(apricotId))
      .map(r => {
        const { apricotId: rowId } = r
        const kinds = kindsByApId.get(rowId!)
        return {
          apricotId: rowId,
          name: r.name || null,
          allocCount: r.allocCount,
          amount: Number(r.amount ?? 0),
          firstMonth: r.firstMonth,
          lastMonth: r.lastMonth,
          clinics: r.clinics ?? [],
          // ★ 前端用呢個做灰色顯示：標咗 UNKNOWN 但仲收緊錢
          status: kinds ? 'MARKED_UNKNOWN' : 'UNBOUND',
        }
      })

    const totalAmount = list.reduce((s, r) => s + r.amount, 0)
    return jsonNoStore({ unassigned: list, count: list.length, totalAmount: Number(totalAmount.toFixed(2)) })
  })
}

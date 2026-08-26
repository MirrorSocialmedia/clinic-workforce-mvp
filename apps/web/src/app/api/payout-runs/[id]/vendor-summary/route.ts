/**
 * GET /api/payout-runs/[id]/vendor-summary — 工廠總覽（跨醫生）
 * ★ 2026-08-26：MD §三 — 按 run.periodMonth ＋ run.clinicId 匯總所有醫生嘅成本。
 * ★ where 唔可以有 providerId（跨醫生）；跟 run.clinicId（單一診所口徑，MD §3.1）。
 * ★ status != VOID 同 finalCost != null 照 engine costWhere —— 合計必須＝各醫生成本總和（驗收 #15）。
 * // ownership-ok: provider_payout 權限（同月結單同一個，MD §3.3）
 */
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { UNNAMED_VENDOR, round2 } from '@/lib/payout/engine'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const id = (await params).id
  const run = await prisma.payoutRun.findUnique({ where: { id } })
  if (!run) return jsonNoStore({ error: '月結單不存在' }, { status: 404 })

  // ★ 跨醫生：冇 providerId；診所口徑跟 run.clinicId
  const where: any = {
    periodMonth: run.periodMonth,
    status: { not: 'VOID' },
    finalCost: { not: null },
  }
  if (run.clinicId) where.clinicId = run.clinicId

  const rows = await prisma.costCase.findMany({
    where,
    select: {
      category: true,
      finalCost: true,
      labOther: true,
      lab: { select: { name: true } },
    },
  })

  // 按工廠聚類（vendor 口徑同 engine.breakdownByVendor / Excel vendorOf 一致：lab.name → labOther → 未指定）
  const m = new Map<string, { labCost: number; implantCost: number; invisalignCost: number; caseCount: number }>()
  for (const c of rows) {
    const vendor: string = String(c.lab?.name || c.labOther || UNNAMED_VENDOR)
    const e = m.get(vendor) ?? { labCost: 0, implantCost: 0, invisalignCost: 0, caseCount: 0 }
    const amt = Number(c.finalCost)
    if (c.category === 'LAB') e.labCost += amt
    else if (c.category === 'IMPLANT') e.implantCost += amt
    else if (c.category === 'INVISALIGN') e.invisalignCost += amt
    e.caseCount += 1
    m.set(vendor, e)
  }

  const vendors = [...m.entries()]
    .map(([vendor, e]) => ({
      vendor,
      labCost: round2(e.labCost),
      implantCost: round2(e.implantCost),
      invisalignCost: round2(e.invisalignCost),
      total: round2(e.labCost + e.implantCost + e.invisalignCost),
      caseCount: e.caseCount,
    }))
    .sort((a, b) => b.total - a.total)

  return jsonNoStore({
    periodMonth: run.periodMonth,
    clinicId: run.clinicId,
    vendors,
  })
}

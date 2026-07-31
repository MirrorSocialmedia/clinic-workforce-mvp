export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { getTimeAccountSummary } from '@/lib/timebank-summary'

/**
 * GET /api/timebank/overview
 * 時間帳戶總覽 —— 所有在職月薪員工（唔理本月有冇活動）
 * 累計餘額同本月活動無關，一個員工上月拖欠 80 分鐘，
 * 就算今個月放晒假，佢嘅累計仍然係 −80，應該顯示。
 */
export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'timebank_ops')
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const sessionClinics = session.clinics ?? []
  if (scope === 'my-clinics' && sessionClinics.length === 0) {
    return NextResponse.json({ summaries: [] })
  }

  // ★ 所有在職員工（唔理本月有冇活動）—— 累計餘額同本月活動無關
  const employees = await prisma.employee.findMany({
    where: {
      status: 'ACTIVE',
      ...(scope === 'my-clinics' ? { homeClinicId: { in: sessionClinics } } : {}),
    },
    include: {
      user: { select: { name: true } },
      payRules: {
        where: { isActive: true },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 1,
        select: { configJson: true },
      },
    },
  })

  const summaries = await getTimeAccountSummary(prisma, employees)
  return jsonNoStore({ summaries: summaries.filter(r => r.timeAccountMinutes != null) })
}

export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { toHKDateStr } from '@/lib/hk-date'
import { calculateTimeBank } from '@/lib/payroll-engine'

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

  const monthDate = new Date(`${toHKDateStr(new Date()).slice(0, 7)}-01T00:00:00+08:00`)
  const summaries = []
  for (const e of employees) {
    let cfg: any = {}
    try { cfg = JSON.parse(e.payRules[0]?.configJson || '{}') } catch {}
    if (cfg.base_type === 'hourly') continue // 兼職不計時間帳戶
    const tb = await calculateTimeBank(e.id, monthDate, cfg, prisma)
    summaries.push({
      employeeId: e.id,
      employeeName: e.user.name,
      timeAccountMinutes: tb.timeAccountMinutes ?? (tb.availableMinutes - tb.owedMinutes),
    })
  }

  return NextResponse.json({ summaries })
}

export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

/**
 * POST /api/timebank/absent-deduct/cancel
 * 取消缺勤扣OT鐘：刪除 ABSENT 類型的 TimeBankEntry
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') {
    return NextResponse.json({ error: '需要老闆權限' }, { status: 403 })
  }

  try {
    const { employeeId, date } = await req.json()
    if (!employeeId || !date) {
      return NextResponse.json({ error: 'employeeId 和 date 必填' }, { status: 400 })
    }

    const dayStart = hkDateStart(date)
    const dayEnd = hkDateEnd(date)

    const entry = await prisma.timeBankEntry.findFirst({
      where: {
        employeeId,
        type: 'MAKEUP',
        targetType: 'ABSENT',
        date: { gte: dayStart, lte: dayEnd },
      },
    })
    if (!entry) return NextResponse.json({ error: '該日未扣OT鐘' }, { status: 400 })

    await prisma.timeBankEntry.delete({ where: { id: entry.id } })

    // Invalidate TimeBank so carry chain recalculates
    await invalidateTimeBankFrom(employeeId, dayStart, prisma)

    await prisma.auditLog.create({
      data: {
        actorId: auth.session.userId,
        action: 'ABSENT_DEDUCT_CANCEL',
        entity: 'TimeBank',
        entityId: employeeId,
        notes: `取消缺勤扣OT鐘 @ ${date}`,
      },
    })

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('absent-deduct cancel error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

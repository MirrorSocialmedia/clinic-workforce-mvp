export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

/**
 * POST /api/timebank/early-in-ot/cancel
 * 取消提早上班 OT：刪除 EARLY_IN_OT entry（唔開負數）
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (!['OWNER', 'MANAGER'].includes(auth.session.role)) {
    return NextResponse.json({ error: '需要老闆或經理權限' }, { status: 403 })
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
        type: 'EARLY_IN_OT',
        date: { gte: dayStart, lte: dayEnd },
      },
    })
    if (!entry) return NextResponse.json({ error: '該日未批准提早上班OT' }, { status: 400 })

    const beforeBalance = await prisma.timeBankEntry.aggregate({
      where: { employeeId },
      _sum: { minutes: true },
    })
    const balanceBefore = beforeBalance._sum.minutes ?? 0

    // Delete (not create negative entry)
    await prisma.timeBankEntry.delete({ where: { id: entry.id } })

    const afterBalance = await prisma.timeBankEntry.aggregate({
      where: { employeeId },
      _sum: { minutes: true },
    })
    const balanceAfter = afterBalance._sum.minutes ?? 0

    // Invalidate TimeBank so carry chain recalculates
    try {
      await invalidateTimeBankFrom(employeeId, dayStart, prisma)
    } catch (e) {
      console.error(`[timebank-cache] invalidate failed employeeId=${employeeId} date=${dayStart}`, e)
    }

    await prisma.auditLog.create({
      data: {
        actorId: auth.session.userId,
        action: 'EARLY_OT_CANCEL',
        entity: 'TimeBankEntry',
        entityId: entry.id,
        targetEmployeeId: employeeId,
        beforeJson: JSON.stringify({
          minutes: entry.minutes,
          date,
          balanceBefore,
        }),
        afterJson: JSON.stringify({ balanceAfter }),
        notes: `取消提早上班OT：${date} −${entry.minutes}分`,
      },
    } as any)

    return NextResponse.json({ success: true, minutes: entry.minutes })
  } catch (err: any) {
    console.error('early-in-ot cancel error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

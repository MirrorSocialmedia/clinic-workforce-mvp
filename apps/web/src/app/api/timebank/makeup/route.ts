export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

async function tbBalance(employeeId: string) {
  const r = await prisma.timeBankEntry.aggregate({ where: { employeeId }, _sum: { minutes: true } })
  return r._sum.minutes ?? 0
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') {
    return NextResponse.json({ error: '只有老闆可補鐘' }, { status: 403 })
  }

  const { employeeId, date, minutes, reason, targetType } = await req.json()

  if (!employeeId || !date || !minutes) {
    return NextResponse.json({ error: 'employeeId, date, minutes 為必填' }, { status: 400 })
  }

  // 嚴格必填：targetType 必須是 LATE 或 EARLY_LEAVE
  if (targetType !== 'LATE' && targetType !== 'EARLY_LEAVE') {
    return NextResponse.json({ error: 'targetType 必須是 LATE 或 EARLY_LEAVE' }, { status: 400 })
  }

  // 🔧 一次性遷移：修復 targetType = null 的舊 MAKEUP 記錄
  try {
    const nullEntries = await prisma.timeBankEntry.findMany({
      where: { type: 'MAKEUP', targetType: null },
      select: { id: true, note: true },
    })
    for (const entry of nullEntries) {
      await prisma.timeBankEntry.update({
        where: { id: entry.id },
        data: { targetType: entry.note?.includes('早退') ? 'EARLY_LEAVE' : 'LATE' },
      })
    }
  } catch { /* 舊版本可能無 targetType 欄位，忽略 */ }

  // 查同日同類型是否已補鐘（按日期+targetType，避免連坐）
  const dateStart = new Date(date + 'T00:00:00+08:00')
  const dateEnd = new Date(date + 'T23:59:59+08:00')
  const existing = await prisma.timeBankEntry.findFirst({
    where: {
      employeeId,
      type: 'MAKEUP',
      targetType, // 直接用，不放 || undefined
      date: { gte: dateStart, lte: dateEnd },
    },
  })
  if (existing) {
    return NextResponse.json({ error: '當天該類型已補鐘' }, { status: 400 })
  }

  // 🔒 防呆：補鐘分鐘不可超過該筆異常的實際分鐘
  {
    const shift = await prisma.shift.findFirst({
      where: {
        employeeId,
        date: dateStart,
        status: { not: 'CANCELLED' },
      },
    })
    if (shift) {
      const { getEffectivePunches } = await import('@/lib/punch-query')
      const dayStart = new Date(date + 'T00:00:00+08:00')
      const dayEnd = new Date(date + 'T23:59:59+08:00')
      const dayPunches = await getEffectivePunches(dayStart, dayEnd, { employeeId, db: prisma })

      let actualMinutes = 0
      if (targetType === 'LATE') {
        const clockIn = dayPunches
          .filter((ep: any) => ep.punchType === 'CLOCK_IN')
          .sort((a: any, b: any) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
        if (clockIn && clockIn.effectiveTime.getTime() > new Date(shift.startTime).getTime()) {
          actualMinutes = Math.ceil((clockIn.effectiveTime.getTime() - new Date(shift.startTime).getTime()) / 60000)
        }
      } else {
        const clockOut = dayPunches
          .filter((ep: any) => ep.punchType === 'CLOCK_OUT')
          .sort((a: any, b: any) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]
        if (clockOut && clockOut.effectiveTime.getTime() < new Date(shift.endTime).getTime()) {
          actualMinutes = Math.ceil((new Date(shift.endTime).getTime() - clockOut.effectiveTime.getTime()) / 60000)
        }
      }

      if (actualMinutes > 0 && Math.abs(parseInt(minutes)) > actualMinutes) {
        return NextResponse.json(
          {
            error: `補鐘分鐘(${Math.abs(parseInt(minutes))})超過實際${targetType === 'EARLY_LEAVE' ? '早退' : '遲到'}分鐘(${actualMinutes})`,
            actualMinutes,
          },
          { status: 400 }
        )
      }
    }
  }

  const beforeBalance = await tbBalance(employeeId)
  const makeup = await prisma.timeBankEntry.create({
    data: {
      employeeId,
      date: new Date(date),
      type: 'MAKEUP',
      minutes: -Math.abs(parseInt(minutes)),
      targetType, // 現在一定有值
      note: `補鐘：${targetType === 'EARLY_LEAVE' ? '早退' : '遲到'} ${Math.abs(parseInt(minutes))}分`,
      createdBy: auth.session.userId,
    },
  })

  // Invalidate TimeBank so carry chain recalculates from makeup date
  await invalidateTimeBankFrom(makeup.employeeId, makeup.date, prisma)

  const afterBalance = await tbBalance(employeeId)

  await prisma.auditLog.create({
    data: {
      actorId: auth.session.userId,
      action: 'TIMEBANK_MAKEUP',
      entity: 'TimeBank',
      entityId: employeeId,
      beforeJson: JSON.stringify({ balanceMinutes: beforeBalance }),
      afterJson: JSON.stringify({ balanceMinutes: afterBalance }),
      notes: JSON.stringify({ delta: -Math.abs(parseInt(minutes)), date, reason: reason?.trim(), targetType }),
    },
  } as any)

  return NextResponse.json({ success: true })
}

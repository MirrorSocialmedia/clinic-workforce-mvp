export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') {
    return NextResponse.json({ error: '只有老闆可補鐘' }, { status: 403 })
  }

  const { employeeId, date, minutes, reason, targetType } = await req.json()

  if (!employeeId || !date || !minutes) {
    return NextResponse.json({ error: 'employeeId, date, minutes 為必填' }, { status: 400 })
  }

  // 查同日同類型是否已補鐘（按日期+targetType，避免連坐）
  const dateStart = new Date(date + 'T00:00:00+08:00')
  const dateEnd = new Date(date + 'T23:59:59+08:00')
  const existing = await prisma.timeBankEntry.findFirst({
    where: {
      employeeId,
      type: 'MAKEUP',
      targetType: targetType || undefined,
      date: { gte: dateStart, lte: dateEnd },
    },
  })
  if (existing) {
    return NextResponse.json({ error: '當天該類型已補鐘' }, { status: 400 })
  }

  const makeup = await prisma.timeBankEntry.create({
    data: {
      employeeId,
      date: new Date(date),
      type: 'MAKEUP',
      minutes: -Math.abs(parseInt(minutes)),
      targetType,
      note: `補鐘：${targetType === 'EARLY_LEAVE' ? '早退' : '遲到'} ${Math.abs(parseInt(minutes))}分`,
      createdBy: auth.session.userId,
    },
  })

  // Invalidate TimeBank so carry chain recalculates from makeup date
  await invalidateTimeBankFrom(makeup.employeeId, makeup.date, prisma)

  await prisma.auditLog.create({
    data: {
      actorId: auth.session.userId,
      action: 'MAKEUP',
      entity: 'TimeBank',
      entityId: employeeId,
      notes: `補鐘 ${minutes}分`,
    },
  })

  return NextResponse.json({ success: true })
}

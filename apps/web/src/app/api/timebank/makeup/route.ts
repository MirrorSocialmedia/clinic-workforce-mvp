export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'

export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', '/api/timebank/makeup')
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') {
    return NextResponse.json({ error: '只有老闆可補鐘' }, { status: 403 })
  }

  const { employeeId, date, minutes, reason } = await req.json()

  if (!employeeId || !date || !minutes) {
    return NextResponse.json({ error: 'employeeId, date, minutes 為必填' }, { status: 400 })
  }

  await prisma.timeBankEntry.create({
    data: {
      employeeId,
      date: new Date(date),
      type: 'MAKEUP',
      minutes: -Math.abs(parseInt(minutes)),
      note: `補鐘：${reason || '遲到/早退'} ${minutes}分`,
      createdBy: auth.session.userId,
    },
  })

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

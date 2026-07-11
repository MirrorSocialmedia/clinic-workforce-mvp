export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'

async function getOtLeaveTypeId() {
  const lt = await prisma.leaveType.findUnique({
    where: { systemKey: 'OT_LEAVE' },
  })
  return lt?.id
}

async function addLeaveBalance(employeeId: string, leaveTypeId: string, days: number) {
  const year = new Date().getFullYear()
  await prisma.leaveBalance.upsert({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    update: { entitled: { increment: days }, remaining: { increment: days } },
    create: { employeeId, leaveTypeId, year, entitled: days, used: 0, remaining: days },
  })
}

async function deductLeaveBalance(employeeId: string, leaveTypeId: string, days: number) {
  const year = new Date().getFullYear()
  await prisma.leaveBalance.updateMany({
    where: { employeeId, leaveTypeId, year },
    data: { entitled: { decrement: days }, remaining: { decrement: days } },
  })
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') {
    return NextResponse.json({ error: '只有老闆可兌換' }, { status: 403 })
  }

  const { employeeId, direction, days } = await req.json()
  const MINUTES_PER_DAY = 9 * 60

  if (!employeeId || !direction || !days) {
    return NextResponse.json({ error: 'employeeId, direction, days 為必填' }, { status: 400 })
  }

  if (direction === 'to_leave') {
    const tb = await calculateTimeBank(employeeId, new Date(), {}, prisma)
    if ((tb as any).availableMinutes < days * MINUTES_PER_DAY) {
      return NextResponse.json({ error: 'OT 時間不足' }, { status: 400 })
    }

    await prisma.timeBankEntry.create({
      data: {
        employeeId,
        date: new Date(),
        type: 'LEAVE_CONVERT',
        minutes: -(days * MINUTES_PER_DAY),
        note: `換 ${days} 天假`,
        createdBy: auth.session.userId,
      },
    })

    const otLeaveTypeId = await getOtLeaveTypeId()
    if (otLeaveTypeId) await addLeaveBalance(employeeId, otLeaveTypeId, days)
  } else {
    const otLeaveTypeId = await getOtLeaveTypeId()
    if (!otLeaveTypeId) {
      return NextResponse.json({ error: '未找到 OT 假類型' }, { status: 400 })
    }

    const otLeave = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: otLeaveTypeId, year: new Date().getFullYear() },
    })
    if (!otLeave || otLeave.remaining < days) {
      return NextResponse.json({ error: 'OT 假不足' }, { status: 400 })
    }

    await prisma.timeBankEntry.create({
      data: {
        employeeId,
        date: new Date(),
        type: 'LEAVE_SWAP_BACK',
        minutes: days * MINUTES_PER_DAY,
        note: `${days} 天 OT 假換回 OT`,
        createdBy: auth.session.userId,
      },
    })
    await deductLeaveBalance(employeeId, otLeaveTypeId, days)
  }

  await prisma.auditLog.create({
    data: {
      actorId: auth.session.userId,
      action: 'CONVERT',
      entity: 'TimeBank',
      entityId: employeeId,
      notes: `${direction} ${days} 天`,
    },
  })

  return NextResponse.json({ success: true })
}

export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'
import { invalidateTimeBankFrom } from '@/lib/punch-query'

async function getOtLeaveTypeId() {
  const lt = await prisma.leaveType.findUnique({
    where: { systemKey: 'OT_LEAVE' },
  })
  return lt?.id
}

async function addLeaveBalance(employeeId: string, leaveTypeId: string, days: number) {
  const year = new Date().getUTCFullYear()
  await prisma.leaveBalance.upsert({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    update: { entitled: { increment: days }, remaining: { increment: days } },
    create: { employeeId, leaveTypeId, year, entitled: days, used: 0, remaining: days },
  })
}

async function deductLeaveBalance(employeeId: string, leaveTypeId: string, days: number) {
  const year = new Date().getUTCFullYear()
  const bal = await prisma.leaveBalance.findUnique({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
  })
  if (!bal || bal.remaining < days) {
    throw new Error('假期餘額不足')
  }
  return prisma.leaveBalance.update({
    where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    data: { used: { increment: days }, remaining: { decrement: days } },
  })
}

async function tbBalance(employeeId: string) {
  const r = await prisma.timeBankEntry.aggregate({ where: { employeeId }, _sum: { minutes: true } })
  return r._sum.minutes ?? 0
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (!['OWNER', 'MANAGER'].includes(auth.session.role)) {
    return NextResponse.json({ error: '只有老闆或經理可兌換' }, { status: 403 })
  }

  const { employeeId, direction, days, note } = await req.json()
  const MINUTES_PER_DAY = 9 * 60

  if (!employeeId || !direction || !days) {
    return NextResponse.json({ error: 'employeeId, direction, days 為必填' }, { status: 400 })
  }

  // 統一強制正整數
  const daysInt = parseInt(String(days), 10)
  if (!Number.isInteger(daysInt) || daysInt < 1) {
    return NextResponse.json({ error: '天數必須為正整數' }, { status: 400 })
  }

  if (direction === 'rest_to_account') {
    // ① 找休息日餘額（REST_DAY 系統類型）
    const restType = await prisma.leaveType.findFirst({ where: { systemKey: 'REST_DAY' } })
    if (!restType) {
      return NextResponse.json({ error: '找不到 REST_DAY 類型' }, { status: 400 })
    }
    // 找員工該類型的 leaveBalance（按年）
    const year = new Date().getUTCFullYear()
    let bal = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: restType.id, year },
    })
    if (!bal || bal.remaining < daysInt) {
      return NextResponse.json({ error: `休息日餘額不足（剩 ${bal?.remaining ?? 0} 天）` }, { status: 400 })
    }
    // 扣減休息日餘額
    await prisma.leaveBalance.update({
      where: { id: bal.id },
      data: { used: bal.used + daysInt, remaining: bal.remaining - daysInt },
    })
    // ② 帳戶進分鐘
    const minutes = Math.round(daysInt * 540)
    const beforeBalance = await tbBalance(employeeId)
    await prisma.timeBankEntry.create({
      data: {
        employeeId,
        date: new Date(),
        type: 'REST_TO_ACCOUNT',
        minutes,
        note: note?.trim() || `假還鐘：休息日 ${daysInt} 天 → +${minutes} 分鐘（償還拖欠）`,
        createdBy: auth.session.userId,
      },
    })
    const afterBalance = await tbBalance(employeeId)
    await prisma.auditLog.create({
      data: {
        actorId: auth.session.userId,
        action: 'TIMEBANK_REST_TO_ACCOUNT',
        entity: 'TimeBank',
        entityId: employeeId,
        targetEmployeeId: employeeId,
        beforeJson: JSON.stringify({ balanceMinutes: beforeBalance }),
        afterJson: JSON.stringify({ balanceMinutes: afterBalance }),
        notes: JSON.stringify({ days: daysInt, minutes, note: note?.trim() }),
      },
    } as any)
    await invalidateTimeBankFrom(employeeId, new Date(), prisma)
    return NextResponse.json({ ok: true })
  }

  if (direction === 'to_leave') {
    const tb = await calculateTimeBank(employeeId, new Date(), {}, prisma)
    if ((tb as any).availableMinutes < daysInt * MINUTES_PER_DAY) {
      return NextResponse.json({ error: 'OT 時間不足' }, { status: 400 })
    }

    const beforeBalance = await tbBalance(employeeId)
    await prisma.timeBankEntry.create({
      data: {
        employeeId,
        date: new Date(),
        type: 'LEAVE_CONVERT',
        minutes: -(daysInt * MINUTES_PER_DAY),
        note: `換 ${daysInt} 天假`,
        createdBy: auth.session.userId,
      },
    })

    const otLeaveTypeId = await getOtLeaveTypeId()
    if (otLeaveTypeId) await addLeaveBalance(employeeId, otLeaveTypeId, daysInt)
    const afterBalance = await tbBalance(employeeId)
    await invalidateTimeBankFrom(employeeId, new Date(), prisma)
    await prisma.auditLog.create({
      data: {
        actorId: auth.session.userId,
        action: 'TIMEBANK_CONVERT',
        entity: 'TimeBank',
        entityId: employeeId,
        targetEmployeeId: employeeId,
        beforeJson: JSON.stringify({ otBalanceMinutes: beforeBalance }),
        afterJson: JSON.stringify({ otBalanceMinutes: afterBalance }),
        notes: JSON.stringify({ delta: -(daysInt * MINUTES_PER_DAY), days: daysInt, direction, date: new Date().toISOString() }),
      },
    } as any)
  } else {
    const otLeaveTypeId = await getOtLeaveTypeId()
    if (!otLeaveTypeId) {
      return NextResponse.json({ error: '未找到 OT 假類型' }, { status: 400 })
    }

    const otLeave = await prisma.leaveBalance.findFirst({
      where: { employeeId, leaveTypeId: otLeaveTypeId, year: new Date().getUTCFullYear() },
    })
    if (!otLeave || otLeave.remaining < daysInt) {
      return NextResponse.json({ error: 'OT 假不足' }, { status: 400 })
    }

    const beforeBalance = await tbBalance(employeeId)
    await prisma.timeBankEntry.create({
      data: {
        employeeId,
        date: new Date(),
        type: 'LEAVE_SWAP_BACK',
        minutes: daysInt * MINUTES_PER_DAY,
        note: `${daysInt} 天 OT 假換回 OT`,
        createdBy: auth.session.userId,
      },
    })
    await deductLeaveBalance(employeeId, otLeaveTypeId, daysInt)
    const afterBalance = await tbBalance(employeeId)
    await invalidateTimeBankFrom(employeeId, new Date(), prisma)
    await prisma.auditLog.create({
      data: {
        actorId: auth.session.userId,
        action: 'TIMEBANK_CONVERT',
        entity: 'TimeBank',
        entityId: employeeId,
        targetEmployeeId: employeeId,
        beforeJson: JSON.stringify({ otBalanceMinutes: beforeBalance }),
        afterJson: JSON.stringify({ otBalanceMinutes: afterBalance }),
        notes: JSON.stringify({ delta: daysInt * MINUTES_PER_DAY, days: daysInt, direction, date: new Date().toISOString() }),
      },
    } as any)
  }

  return NextResponse.json({ success: true })
}

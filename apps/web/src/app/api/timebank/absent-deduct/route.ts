export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { invalidateTimeBankFrom } from '@/lib/punch-query'
import { computeAbsentDeductMinutes } from '@/lib/absent-deduct-minutes'

async function tbBalance(employeeId: string) {
  const r = await prisma.timeBankEntry.aggregate({ where: { employeeId }, _sum: { minutes: true } }) // AGG-OK: timebank management
  return r._sum.minutes ?? 0
}

/**
 * POST /api/timebank/absent-deduct
 * 缺勤扣OT鐘：用時間帳戶買回缺勤工資扣款
 * 規則：不扣工資（全薪），不影響勤工獎，扣當天排班時數
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

    // 驗證①：那天真的缺勤（有排班、無有效打卡、無已批假）
    const dayStart = hkDateStart(date)
    const dayEnd = hkDateEnd(date)

    // ★ 唔可以扣未發生嘅日子 —— 前端曾經因為 exceptions 標錯未來缺勤而顯示咗掣。
    // 就算前端修好，API 都要自己守（可能有人直接打）。
    if (dayStart.getTime() > Date.now()) {
      return NextResponse.json(
        { error: `${date} 尚未到，唔可以扣缺勤` },
        { status: 400 },
      )
    }

    // 攞當日全部更次（孖更日有多張更）
    const sameDayShifts = await prisma.shift.findMany({
      where: {
        employeeId,
        date: { gte: dayStart, lte: dayEnd },
        status: { not: 'CANCELLED' },
      },
      include: { template: { select: { deductLunch: true } } },
    })
    if (sameDayShifts.length === 0) return NextResponse.json({ error: '該日無排班' }, { status: 400 })

    // 檢查是否已批假
    const hasLeave = await prisma.leaveRequest.findFirst({
      where: {
        employeeId,
        status: 'APPROVED',
        startDate: { lte: dayEnd },
        endDate: { gte: dayStart },
      },
    })
    if (hasLeave) return NextResponse.json({ error: '該日已批假，非缺勤' }, { status: 400 })

    // 檢查是否有打卡（排除 voided）
    const hasPunch = await prisma.punchRecord.findFirst({
      where: {
        employeeId,
        punchTime: { gte: dayStart, lte: dayEnd },
        void: { is: null },
      },
    })
    if (hasPunch) return NextResponse.json({ error: '該日有打卡，非缺勤' }, { status: 400 })

    // 驗證②：防重複
    const existing = await prisma.timeBankEntry.findFirst({
      where: {
        employeeId,
        type: 'MAKEUP',
        targetType: 'ABSENT',
        date: { gte: dayStart, lte: dayEnd },
      },
    })
    if (existing) return NextResponse.json({ error: '該日已扣OT鐘' }, { status: 400 })

    // 計算扣分鐘：加總當日全部更次 → 按 deductLunch gate 扣一次午飯
    // ★ 2026-08-08: payRule query 條件同 payroll-engine.ts:1491-1498 一致
    const empPayRule = await prisma.payRule.findFirst({
      where: {
        employeeId,
        isActive: true,
        effectiveFrom: { lte: dayEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: dayStart } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    })
    let lunchMinutes = 60
    if (empPayRule?.configJson) {
      try {
        lunchMinutes = JSON.parse(empPayRule.configJson)?.modifiers?.lunch_break?.defaultMinutes ?? 60
      } catch (e) {
        console.error('[absent-deduct] bad configJson employeeId=', employeeId, e)
      }
    }
    const { minutes: shiftMinutes } = computeAbsentDeductMinutes(sameDayShifts as any, lunchMinutes)

    const beforeBalance = await tbBalance(employeeId)
    const entry = await prisma.timeBankEntry.create({
      data: {
        employeeId,
        type: 'MAKEUP',
        targetType: 'ABSENT',
        date: dayStart,
        minutes: -shiftMinutes,
        note: `缺勤扣OT鐘 ${shiftMinutes}分`,
        createdBy: auth.session.userId,
      },
    })

    // Invalidate TimeBank so carry chain recalculates
    try {
      await invalidateTimeBankFrom(employeeId, entry.date, prisma)
    } catch (e) {
      console.error(`[timebank-cache] invalidate failed employeeId=${employeeId} date=${entry.date}`, e)
    }

    const afterBalance = await tbBalance(employeeId)

    await prisma.auditLog.create({
      data: {
        actorId: auth.session.userId,
        action: 'TIMEBANK_ABSENT_DEDUCT',
        entity: 'TimeBank',
        entityId: employeeId,
        targetEmployeeId: employeeId,
        beforeJson: JSON.stringify({ balanceMinutes: beforeBalance }),
        afterJson: JSON.stringify({ balanceMinutes: afterBalance }),
        notes: JSON.stringify({ delta: -shiftMinutes, date, reason: '缺勤扣OT鐘' }),
      },
    } as any)

    return NextResponse.json({ success: true, shiftMinutes })
  } catch (err: any) {
    console.error('absent-deduct error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

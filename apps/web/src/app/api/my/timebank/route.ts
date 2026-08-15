export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'
import { toHKDateStr } from '@/lib/hk-date'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', '/api/my/timebank')
  if (isAuthError(auth)) return auth.error

  const employee = await prisma.employee.findUnique({
    where: { userId: auth.session.userId },
    select: { id: true },
  })
  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const tb = await calculateTimeBank(employee.id, new Date(), {}, prisma)

  // ★ 本月 + 上月明細
  const now = new Date()
  const hkNow = new Date(now.getTime() + 8 * 3600 * 1000)
  const y = hkNow.getUTCFullYear()
  const m = hkNow.getUTCMonth()
  // 上月 1 號 HK 00:00
  const from = new Date(Date.UTC(y, m - 1, 1) - 8 * 3600 * 1000)

  const entries = await prisma.timeBankEntry.findMany({
    where: { employeeId: employee.id, date: { gte: from } },
    orderBy: { date: 'desc' },
    select: { id: true, date: true, type: true, minutes: true, note: true, targetType: true },
    take: 200,
  })

  return NextResponse.json({
    timeAccountMinutes: tb.timeAccountMinutes,
    balance: tb.balance,
    otMinutes: tb.otMinutes,
    lateMinutes: tb.lateMinutes,
    netLateMinutes: tb.netLateMinutes,
    earlyLeaveMinutes: tb.earlyLeaveMinutes,
    netEarlyMinutes: tb.netEarlyMinutes,
    carriedFrom: tb.carriedFrom,
    entries: entries.map(e => ({
      id: e.id,
      date: toHKDateStr(e.date),
      type: e.type,
      targetType: e.targetType,
      minutes: e.minutes,
      note: e.note,
    })),
    // ★ 考勤 OT —— 由打卡即時計算，未入 TimeBankEntry
    attendanceOt: {
      otMinutes: tb.otMinutes, // 午休 OT + 收工 OT
      lateMinutes: tb.netLateMinutes,
    },
    // ★ 逐日考勤明細（calculateTimeBank 一直有計，之前冇回）
    attendanceDays: (tb.timeAccountDetail ?? [])
      .slice()
      .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))),
  })
}

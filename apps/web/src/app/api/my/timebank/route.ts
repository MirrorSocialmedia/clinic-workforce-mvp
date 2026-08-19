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
    // ★ 2026-08-19: 四格新增欄 — ② 午休 OT（已含喺 otMinutes 入面，前端要減走先）
    lunchOtMinutes: tb.lunchOtMinutes,
    earlyInOtMinutes: tb.earlyInOtMinutes,
    lateMinutes: tb.lateMinutes,
    netLateMinutes: tb.netLateMinutes,
    earlyLeaveMinutes: tb.earlyLeaveMinutes,
    netEarlyMinutes: tb.netEarlyMinutes,
    // ★ 2026-08-19: 補鐘細項 — makeupMinutes = late + early + absent（全部計入第③格）
    makeupMinutes: tb.makeupMinutes,
    makeupLateMinutes: tb.makeupLateMinutes,
    makeupEarlyMinutes: tb.makeupEarlyMinutes,
    makeupAbsentMinutes: tb.makeupAbsentMinutes,
    carriedFrom: tb.carriedFrom,
    netOtThisMonth: tb.netOtThisMonth,
    entries: entries.map(e => ({
      id: e.id,
      date: toHKDateStr(e.date),
      type: e.type,
      targetType: e.targetType,
      minutes: e.minutes,
      note: e.note,
    })),
  })
}

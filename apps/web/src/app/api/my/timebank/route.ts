export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'
import { jsonNoStore } from '@/lib/api-response'

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', '/api/my/timebank')
  if (isAuthError(auth)) return auth.error

  const employee = await prisma.employee.findUnique({
    where: { userId: auth.session.userId },
    select: { id: true },
  })
  if (!employee) return NextResponse.json({ error: 'Employee profile not found' }, { status: 400 })

  const tb = await calculateTimeBank(employee.id, new Date(), {}, prisma)

  return jsonNoStore({
    timeAccountMinutes: tb.timeAccountMinutes,
    balance: tb.balance,
    otMinutes: tb.otMinutes,
    // ★ 2026-08-19: 四格新增欄 — ② 午休 OT（已含喺 otMinutes 入面，前端要減走先）
    lunchOtMinutes: tb.lunchOtMinutes,
    earlyInOtMinutes: tb.earlyInOtMinutes,
    // ★ 2026-08-31 (cwm-earlyin)：鐘口徑（otMinutes + earlyInOt）—— 前端「未入帳 OT」要用佢，
    //   否則逐日加起身 ≠ 顯示嘅總數（早返唔喺 otMinutes 入面）。
    //   引擎已經計好（otMinutesForAccount），呢度只係補轉發。
    otMinutesForAccount: tb.otMinutesForAccount,
    // ★ 本月預測逐項加減要用（拍板：其他調整 = convertedMinutes − 換假 − 換回）
    convertedMinutes: tb.convertedMinutes,
    // ★ OT 換假／退回拆分（拍板①③：有值先顯示，分鐘＋天都顯示）
    leaveConvertMinutes: tb.leaveConvertMinutes,
    leaveSwapBackMinutes: tb.leaveSwapBackMinutes,
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
    // ★ 逐日考勤明細 —— calculateTimeBank 一直有計（payroll-engine:1656-1660），
    //   只係之前冇回。員工要睇「邊日有 OT／早退」，唔係睇 INIT_ADJUST。
    //   拍板 2026-08-21：保留逐日考勤、剷 TimeBankEntry 清單（entries/findMany 一併剷）。
    attendanceDays: (tb.timeAccountDetail ?? [])
      .slice()
      .sort((a: any, b: any) => String(b.date).localeCompare(String(a.date))),
  })
}

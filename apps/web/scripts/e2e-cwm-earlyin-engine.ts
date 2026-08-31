/**
 * cwm-earlyin-20260831 — engine-level 驗證腳本（v5/v6 通用）
 * 跑法（apps/web 目錄）：npx tsx scripts/e2e-cwm-earlyin-engine.ts
 * 輸出：單行 JSON（EB_RESULT）— 方便 v5/v6 diff。
 */
import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'
import { computeRosterHours } from '@/lib/roster-hours'

const EMP = 'e2ekathyemp202608310001'
const CLINIC = 'e2ekathyclinic202608310001'

async function main() {
  const monthStr = process.env.EB_MONTH || '2026-08'
  const monthDate = new Date(monthStr + '-01T00:00:00+08:00') // HK month
  const tb = await calculateTimeBank(EMP, monthDate, { negative_carry: 'next_month' }, prisma)

  // roster（同 dashboard 同一條路徑：computeRosterHours）
  const rhMap = await computeRosterHours([EMP], monthStr, prisma)
  const rh = rhMap.get(EMP) ?? { expectedMinutes: 0, rosterMinutes: 0, diffMinutes: 0, unscheduled: true }

  const detail = (tb.timeAccountDetail ?? []) as any[]
  const otSum = detail.reduce((s: number, d: any) =>
    s + (d.clockOutOt ?? 0) + (d.holidayOt ?? 0) + (d.lunchOt ?? 0) + (d.earlyInOt ?? 0), 0)
  const aug07 = detail.filter((d: any) => d.date === '2026-08-07')
  const dates = detail.map((d: any) => d.date)
  const sortedDesc = [...dates].sort((a, b) => String(b).localeCompare(String(a)))
  // 排除 display-only 新欄後嘅「金額相關」欄 — #25 v5/v6 必須完全一致
  const money = {
    otMinutes: tb.otMinutes,
    lunchOtMinutes: tb.lunchOtMinutes,
    earlyInOtMinutes: tb.earlyInOtMinutes,
    lateMinutes: tb.lateMinutes,
    netLateMinutes: tb.netLateMinutes,
    earlyLeaveMinutes: tb.earlyLeaveMinutes,
    netEarlyMinutes: tb.netEarlyMinutes,
    netDeficitMinutes: tb.netDeficitMinutes,
    makeupMinutes: tb.makeupMinutes,
    makeupLateMinutes: tb.makeupLateMinutes,
    carriedFrom: tb.carriedFrom,
    timeAccountMinutes: tb.timeAccountMinutes,
    netOtThisMonth: tb.netOtThisMonth,
    convertedMinutes: tb.convertedMinutes,
    balance: tb.balance,
    availableMinutes: tb.availableMinutes,
    owedMinutes: tb.owedMinutes,
    convertibleLeaveDays: tb.convertibleLeaveDays,
  }
  const result = {
    money,
    otMinutesForAccount: tb.otMinutesForAccount,
    leaveConvertMinutes: tb.leaveConvertMinutes,
    leaveSwapBackMinutes: tb.leaveSwapBackMinutes,
    otSumDetail: otSum,
    detailRowCount: detail.length,
    aug07Rows: aug07,
    datesSortedDesc: JSON.stringify(dates) === JSON.stringify(sortedDesc),
    roster: rh,
    // #16 預測（照 MD §四 口徑）
    forecast: {
      carriedFrom: tb.carriedFrom,
      netOtThisMonth: tb.netOtThisMonth,
      otherAdjust: (tb.convertedMinutes ?? 0) - (tb.leaveConvertMinutes ?? 0) - (tb.leaveSwapBackMinutes ?? 0),
      currentBalance: tb.balance,
      scheduledOt: rh.diffMinutes,
      projectedEnd: tb.balance + (rh.diffMinutes ?? 0),
    },
  }
  console.log('EB_RESULT ' + JSON.stringify(result))
}

main().catch((e) => { console.error('EB_FAIL', e); process.exit(1) })
  .finally(() => prisma.$disconnect())

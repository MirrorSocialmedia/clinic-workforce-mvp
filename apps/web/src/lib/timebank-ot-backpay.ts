// ============================================================
// ★ cwm-otbackpay-20261010：搵返「OT 門檻設錯」少計嘅 OT，補回去之後嘅月份
//
// 背景：大圍員工薪酬規則曾經設咗「每日 OT 滿 15 分鐘先計」（modifiers.overtime.ot_min_minutes），
//   實際公司冇呢個限制 —— 8、9 月已確認計糧，每日 OT 唔夠 15 分鐘嘅都冇入時間帳戶。
//
// 做法（唔郁已出糧月份）：
//   同一個月用同一套引擎計兩次 —— 當時門檻（A）同 不限（B）——
//   逐日比較「下班 OT」＋「假期／休息日返工 OT」，B − A > 0 就係少計咗。
//   兩次都用 calculateTimeBank 同一份打卡／更表，差額 100% 嚟自門檻（之後改過打卡唔會混入）。
//   補回 = 喺補回月份寫一筆 TimeBankEntry(OT_BACKPAY)，每個來源月份一筆。
// ============================================================
import { calculateTimeBank } from './payroll-engine'

export interface OtBackpayDay {
  date: string     // YYYY-MM-DD（HK）
  credited: number // 當時計咗嘅 OT 分鐘（有門檻）
  correct: number  // 應該計嘅 OT 分鐘（不限）
  diff: number     // correct − credited（> 0 先列）
}

type Detail = Array<{ date: string; clockOutOt?: number; holidayOt?: number }>

const otOf = (d: { clockOutOt?: number; holidayOt?: number } | undefined) =>
  (d?.clockOutOt ?? 0) + (d?.holidayOt ?? 0)

/** 純函數：逐日比較兩份 timeAccountDetail（只計門檻影響到嘅兩種 OT），只回 diff > 0 嘅日子，按日期排 */
export function otBackpayDays(credited: Detail, correct: Detail): OtBackpayDay[] {
  const byDate = (rows: Detail) => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.date, (m.get(r.date) ?? 0) + otOf(r))
    return m
  }
  const a = byDate(credited)
  const b = byDate(correct)
  const out: OtBackpayDay[] = []
  for (const [date, correctMin] of b) {
    const creditedMin = a.get(date) ?? 0
    const diff = correctMin - creditedMin
    if (diff > 0) out.push({ date, credited: creditedMin, correct: correctMin, diff })
  }
  return out.sort((x, y) => x.date.localeCompare(y.date))
}

/**
 * 某員工某月：當時門檻（threshold）vs 不限 —— 逐日少計咗幾多 OT。
 * threshold 由 caller 指定（規則已經原地改走咗都計得返）。
 */
export async function findOtBackpay(db: any, employeeId: string, periodMonth: string, threshold: number) {
  const monthDate = new Date(`${periodMonth}-01T00:00:00+08:00`)
  const a = await calculateTimeBank(employeeId, monthDate, {}, db, 0, { otMinMinutes: threshold })
  const b = await calculateTimeBank(employeeId, monthDate, {}, db, 0, { otMinMinutes: 0 })
  const days = otBackpayDays(a.timeAccountDetail as Detail, b.timeAccountDetail as Detail)
  return {
    days,
    totalMinutes: days.reduce((s, d) => s + d.diff, 0),
    degraded: !!(a.degraded || b.degraded),
  }
}

/** 補回 entry 嘅 note（帶 [otbp:YYYY-MM] 標記 —— 防重複補） */
export const otBackpayTag = (sourceMonth: string) => `[otbp:${sourceMonth}]`
export function otBackpayNote(sourceMonth: string, threshold: number, days: OtBackpayDay[]): string {
  const list = days.map(d => `${d.date.slice(5)} +${d.diff}`).join('、')
  return `${otBackpayTag(sourceMonth)} 補回 ${sourceMonth} 少計 OT（舊設定 OT 滿 ${threshold} 分鐘先計）：${days.length} 日共 ${days.reduce((s, d) => s + d.diff, 0)} 分鐘（${list}）`
}

import { toHKDateStr } from './hk-date'

/**
 * ★ 打卡時間截到分鐘 —— 秒數一律唔計（2026-08-15 拍板）
 * 早退 19:30:40 → 19:30（差 60 分，唔係 59）
 * OT 19:37:47 → 19:37（差 7 分，唔係 8）
 *
 * ⚠️ 全系統任何「打卡 vs 更次」嘅分鐘計算都要經呢個 helper。
 * 直接寫 Math.floor(diff/60000) 或 Math.ceil 都係錯。
 */
export const truncToMinute = (d: Date): number =>
  Math.floor(d.getTime() / 60000) * 60000

/** 兩個時刻相差幾多分鐘（兩邊都先截秒，結果必為整數） */
export const diffMinutes = (later: Date, earlier: Date): number =>
  (truncToMinute(later) - truncToMinute(earlier)) / 60000

export type MatchedDay = {
  date: string // HK YYYY-MM-DD
  shiftId: string
  clinicId: string
  // ★ 四個欄一律「截秒後相減」—— 見 diffMinutes（2026-08-15）
  lateMinutes: number // 未計午休超時
  earlyMinutes: number
  otMinutes: number // 未過門檻／未套 otRoundMinutes 嘅原始值
  earlyInMinutes: number
  hasClockIn: boolean
  hasClockOut: boolean
  isPartial: boolean // 有 IN 冇 OUT
}

/**
 * 打卡 ↔ 更次配對 —— 全系統唯一實作。
 *
 * ★ 呢個係純函數：唔查 DB、唔遞歸、唔理月份。
 * 任何要「由打卡同更次算出遲到／早退／OT」嘅地方都要用佢。
 *
 * 修正咗嘅四樣：
 * ① clinicId 過濾含 secondaryClinicId（調鋪）
 * ② 同店多張更時用時間窗切開（分更朝晚更）
 * ③ 取整規則見下方註釋（2026-08-15 拍板）
 * ④ 揀最早 CLOCK_IN / 最晚 CLOCK_OUT
 */
export function matchPunchesToShifts(
  shifts: Array<{
    id: string
    date: Date | string
    startTime: Date | string
    endTime: Date | string
    clinicId: string
    secondaryClinicId?: string | null
    status?: string
  }>,
  punches: Array<{
    effectiveTime: Date
    punchType: string
    clinicId: string
  }>,
): MatchedDay[] {
  const out: MatchedDay[] = []

  // ★ 取整規則（2026-08-15 拍板 B2）：一律截秒後相減（diffMinutes）
  // 秒數唔計 —— 打卡 19:30:40 = 19:30，更次 19:30:00 = 19:30，差 0 分。
  // 詳見 truncToMinute / diffMinutes helper。

  for (const shift of shifts) {
    if (shift.status === 'CANCELLED') continue

    const shiftDateStr = toHKDateStr(new Date(shift.date))
    const shiftStart = new Date(shift.startTime)
    const shiftEnd = new Date(shift.endTime)

    // ★ 同店同日多過一張更 → 要時間窗切開（分更）
    //   clinic 定義：相同 clinicId 或 secondaryClinicId 交集
    const sameDaySameClinic = shifts.filter(s =>
      s.status !== 'CANCELLED' &&
      toHKDateStr(new Date(s.date)) === shiftDateStr &&
      (s.clinicId === shift.clinicId ||
       s.clinicId === shift.secondaryClinicId ||
       s.secondaryClinicId === shift.clinicId)
    )
    const needTimeWindow = sameDaySameClinic.length > 1

    let winStart = -Infinity
    let winEnd = Infinity
    if (needTimeWindow) {
      const sorted = sameDaySameClinic
        .slice()
        .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
      const idx = sorted.findIndex(s => s.id === shift.id)
      const prev = sorted[idx - 1]
      const next = sorted[idx + 1]
      // ★ 窗口 = 同前一更收工嘅中點 → 同下一更開工嘅中點
      //   呢個算法同 calculateTimeBank 完全一致（payroll-engine.ts:1472-1478）
      winStart = prev
        ? (new Date(prev.endTime).getTime() + shiftStart.getTime()) / 2
        : -Infinity
      winEnd = next
        ? (shiftEnd.getTime() + new Date(next.startTime).getTime()) / 2
        : Infinity
    }

    const dayPunches = punches.filter(p => {
      if (toHKDateStr(p.effectiveTime) !== shiftDateStr) return false
      if (p.clinicId !== shift.clinicId && p.clinicId !== shift.secondaryClinicId) return false
      if (!needTimeWindow) return true
      const t = p.effectiveTime.getTime()
      return t >= winStart && t < winEnd
    })

    const clockIn = dayPunches
      .filter(p => p.punchType === 'CLOCK_IN')
      .sort((a, b) => a.effectiveTime.getTime() - b.effectiveTime.getTime())[0]
    const clockOut = dayPunches
      .filter(p => p.punchType === 'CLOCK_OUT')
      .sort((a, b) => b.effectiveTime.getTime() - a.effectiveTime.getTime())[0]

    let lateMinutes = 0
    let earlyMinutes = 0
    let otMinutes = 0
    let earlyInMinutes = 0

    if (clockIn) {
      const d = diffMinutes(clockIn.effectiveTime, shiftStart)
      if (d > 0) lateMinutes = d
      else if (d < 0) earlyInMinutes = -d
    }
    if (clockOut) {
      const d = diffMinutes(clockOut.effectiveTime, shiftEnd)
      if (d > 0) otMinutes = d
      else if (d < 0) earlyMinutes = -d
    }

    out.push({
      date: shiftDateStr,
      shiftId: shift.id,
      clinicId: shift.clinicId,
      lateMinutes,
      earlyMinutes,
      otMinutes,
      earlyInMinutes,
      hasClockIn: !!clockIn,
      hasClockOut: !!clockOut,
      isPartial: !!clockIn && !clockOut,
    })
  }

  return out
}

/**
 * 排班預估工時（未有打卡時用）。
 * ★ 按「員工 + 日期」group —— 分更日一日只扣一次午飯，
 *   唔好每張更各減一次（會令 09-13 + 15-19 由 8h 變 6h）。
 * ★ Per-day template flag: 只喺「該日有至少一張更要扣」先扣；
 *   全部都剔走 → 唔扣；冇 template 嘅自訂更 → 照扣（同 engine 語義一致）。
 * ★ 2026-08-09: 孖更邏輯保留（engine 支援一日多更、只扣一次午飯），
 * 但 UI 已封晒入口（collision_check 只准取代，唔准加多一張）。
 * 如果日後要重開孖更，改 createShift 個 onConflict 分支，唔使郁呢度。
 */
export function estimateScheduledHours(
  shifts: Array<{ employeeId: string; date: Date | string; startTime: Date | string; endTime: Date | string; status?: string }>,
  lunchMinutesByEmployee: (employeeId: string) => number,
): Map<string, { date: string; hours: number }[]> {
  const byEmpDay = new Map<string, number>()
  const dayDeducts = new Map<string, boolean>() // ★ 該日有冇「要扣」嘅更
  for (const s of shifts) {
    if (s.status === 'CANCELLED') continue
    const key = `${s.employeeId}:${toHKDateStr(new Date(s.date))}`
    const ms = new Date(s.endTime).getTime() - new Date(s.startTime).getTime()
    byEmpDay.set(key, (byEmpDay.get(key) ?? 0) + ms)
    // 冇 template / template.deductLunch 唔係 false → 照扣（同 engine 語義）
    dayDeducts.set(key, (dayDeducts.get(key) ?? false) || (s as any).template?.deductLunch !== false)
  }
  const out = new Map<string, { date: string; hours: number }[]>()
  for (const [key, ms] of byEmpDay) {
    const [empId, date] = key.split(':')
    const lunchH = dayDeducts.get(key) ? lunchMinutesByEmployee(empId) / 60 : 0
    const hours = Math.max(0, ms / 3600000 - lunchH)
    if (!out.has(empId)) out.set(empId, [])
    out.get(empId)!.push({ date, hours })
  }
  return out
}


// ============================================================
// ★ cwm-ledgerpunch-20261006：員工手機時間帳戶 —— 逐日打卡時間
//   一日打卡多過一次（調鋪／補打）：上班取最早、放工取最遲、午膳出取最早、午膳入取最遲（老闆確認）
//   用 getEffectivePunches（已計更正、已排除作廢）—— 唔另外自己讀打卡表
// ============================================================
import { toHKDateStr, fmtTime } from './hk-date'

export interface PunchDaySummary { in: string | null; out: string | null; lunchOut: string | null; lunchIn: string | null }

/** 純函數：有效打卡 → 每日（HK）上班／放工／午膳 */
export function summarizePunchDays(punches: Array<{ punchType: string; effectiveTime: Date }>): Record<string, PunchDaySummary> {
  const out: Record<string, { in?: Date; out?: Date; lunchOut?: Date; lunchIn?: Date }> = {}
  for (const p of punches) {
    const d = toHKDateStr(p.effectiveTime)
    const day = (out[d] ??= {})
    const t = p.effectiveTime
    if (p.punchType === 'CLOCK_IN' && (!day.in || t < day.in)) day.in = t
    else if (p.punchType === 'CLOCK_OUT' && (!day.out || t > day.out)) day.out = t
    else if (p.punchType === 'LUNCH_START' && (!day.lunchOut || t < day.lunchOut)) day.lunchOut = t
    else if (p.punchType === 'LUNCH_END' && (!day.lunchIn || t > day.lunchIn)) day.lunchIn = t
  }
  const fmt = (d?: Date) => (d ? fmtTime(d) : null)
  return Object.fromEntries(Object.entries(out).map(([d, v]) => [d, { in: fmt(v.in), out: fmt(v.out), lunchOut: fmt(v.lunchOut), lunchIn: fmt(v.lunchIn) }]))
}

/** 純函數：顯示文案（冇打嘅照寫，唔好靜靜留空） */
export function punchLine(s: PunchDaySummary | undefined): string {
  if (!s || (!s.in && !s.out && !s.lunchOut && !s.lunchIn)) return '冇打卡紀錄'
  const work = `打卡 ${s.in ?? '？（未打上班）'}–${s.out ?? '？（未打放工）'}`
  const lunch = s.lunchOut || s.lunchIn ? `午膳 ${s.lunchOut ?? '？'}–${s.lunchIn ?? '？'}` : '午膳 冇打'
  return `${work} · ${lunch}`
}

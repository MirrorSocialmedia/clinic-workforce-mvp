// ============================================================
// ★ cwm-probation-20261003：試用期提醒（共用純函數 —— 前端／API 都用）
//
// 試用期 = 入職起 PROBATION_MONTHS（3）個月，同 leave-calculation.serviceMonths 同一口徑：
//   7/15 入職 → 10/15 滿 3 個月 → 試用期最後一日 = 10/14
//   月尾入職遇短月（11/30 → 2/28）用當月最後一日（同 serviceMonths fallback）
// ============================================================
import { toHKDateStr, addDaysStr } from '@/lib/hk-date'
import { PROBATION_MONTHS } from '@/lib/leave-calculation'

/** 滿試用期嗰日（第一日唔再係試用期，HK YYYY-MM-DD） */
export function probationPassDateStr(joinDate: Date | string, months: number = PROBATION_MONTHS): string {
  const j = toHKDateStr(joinDate)
  const [y, m, d] = j.split('-').map(Number)
  const total = (m - 1) + months
  const ty = y + Math.floor(total / 12)
  const tm = (total % 12) + 1
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate()
  return `${ty}-${String(tm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/** 試用期最後一日 */
export function probationLastDayStr(joinDate: Date | string, months: number = PROBATION_MONTHS): string {
  return addDaysStr(probationPassDateStr(joinDate, months), -1)
}

export interface ProbationDue {
  id: string
  name: string
  clinicName: string
  joinDate: string
  lastDay: string // 試用期最後一日
  daysLeft: number // 0 = 今日係最後一日；負數 = 已過咗幾日
}

const dayDiff = (a: string, b: string) =>
  Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86400000)

/**
 * 試用期將滿／啱啱滿嘅員工：最後一日喺 [today − after, today + ahead] 之內（已離職唔計）。
 * 排序：最急（daysLeft 細）先。
 */
export function probationDueList(
  emps: Array<{ id: string; status?: string; joinDate?: Date | string | null; user?: { name?: string | null } | null; homeClinic?: { name?: string | null } | null }>,
  todayStr: string,
  ahead = 30,
  after = 14,
): ProbationDue[] {
  const out: ProbationDue[] = []
  for (const e of emps) {
    if (e.status === 'RESIGNED' || !e.joinDate) continue
    const lastDay = probationLastDayStr(e.joinDate)
    const daysLeft = dayDiff(todayStr, lastDay)
    if (daysLeft > ahead || daysLeft < -after) continue
    out.push({ id: e.id, name: e.user?.name ?? '?', clinicName: e.homeClinic?.name ?? '', joinDate: toHKDateStr(e.joinDate), lastDay, daysLeft })
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.name.localeCompare(b.name))
}

/** 顯示用：「仲有 5 日（10/14 最後一日）」／「今日最後一日」／「已滿 3 日」 */
export function probationDueLabel(p: ProbationDue): string {
  const md = `${Number(p.lastDay.slice(5, 7))}/${Number(p.lastDay.slice(8, 10))}`
  if (p.daysLeft > 0) return `仲有 ${p.daysLeft} 日（${md} 最後一日）`
  if (p.daysLeft === 0) return `今日（${md}）係最後一日`
  return `已滿 ${-p.daysLeft} 日（${md} 最後一日）`
}

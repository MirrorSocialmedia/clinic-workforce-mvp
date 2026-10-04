// ★ cwm-chequeexcl-20261004：模版「匯出邊啲員工」嘅試用期提示（純函數）
//   老闆拍板：系統唔自動剔，只提示 ——
//   ① 試用期中（3 個月，同 lib/probation 口徑）→ 橙色提示
//   ② 已過試用期但仲剔走緊 → 紅色提示（記得剔返）
import { toHKDateStr } from '@/lib/hk-date'
import { probationPassDateStr, probationLastDayStr } from '@/lib/probation'

export type ExcludeHint =
  | { kind: 'PROBATION'; lastDay: string; dayNo: number }
  | { kind: 'PASSED_EXCLUDED'; lastDay: string }
  | null

const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000

export function excludeHint(joinDate: Date | string | null | undefined, excluded: boolean, today: string = toHKDateStr(new Date())): ExcludeHint {
  if (!joinDate) return null
  const join = toHKDateStr(joinDate)
  if (join > today) return { kind: 'PROBATION', lastDay: probationLastDayStr(join), dayNo: 0 } // 未入職
  const inProbation = today < probationPassDateStr(join)
  if (inProbation) return { kind: 'PROBATION', lastDay: probationLastDayStr(join), dayNo: dayNum(today) - dayNum(join) + 1 }
  if (excluded) return { kind: 'PASSED_EXCLUDED', lastDay: probationLastDayStr(join) }
  return null
}

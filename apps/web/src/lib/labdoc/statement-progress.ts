/**
 * ★ cwm-labstmtprog-20261012：Lab 月結單 —— 某月逐間診所「已對／對數中／未對／未收到」（純函數）
 *
 * 一份月結單可以有幾段（每段 = 診所 × 醫生）；按「呢份單喺呢間診所嘅段」計：
 *   全部段 CONFIRMED = 已對；部分 = 對數中；一段都未確認（或者未分段）= 未對。
 *   一份單跨幾間診所 → 每間各計一次。已作廢／重複／已取代唔計。
 *   未分段（讀緊／待確認）→ 歸單頭診所，冇就歸上傳店；都冇 → unassigned（唔知邊間店）。
 * 未收到（老闆 2026-10-12 要）：嗰間診所嗰個月有 Lab 成本（CostCase LAB，未作廢），
 *   但冇嗰間 Lab 嘅月結單（喺嗰間診所有段／單頭係嗰間）→ 列 Lab 名。
 */
export const STATEMENT_EXCLUDED = new Set(['VOID', 'SUPERSEDED', 'DUPLICATE'])

export interface ProgStatementIn {
  id: string
  labId: string | null
  status: string
  clinicId: string | null
  uploadClinicId: string | null
  sections: Array<{ clinicId: string | null; status: string }>
}
export interface ProgCostIn { clinicId: string; labId: string }

export type ProgState = 'RECONCILED' | 'IN_PROGRESS' | 'OPEN'

export interface ClinicProgress {
  clinicId: string
  reconciled: number
  inProgress: number
  open: number
  /** 有成本但未收到月結單嘅 Lab（labId） */
  missingLabIds: string[]
}

export function statementProgress(statements: ProgStatementIn[], costs: ProgCostIn[]): { clinics: ClinicProgress[]; unassigned: number } {
  const byClinic = new Map<string, ClinicProgress>()
  const get = (clinicId: string) => {
    let c = byClinic.get(clinicId)
    if (!c) { c = { clinicId, reconciled: 0, inProgress: 0, open: 0, missingLabIds: [] }; byClinic.set(clinicId, c) }
    return c
  }
  const covered = new Set<string>() // `${clinicId}|${labId}`
  let unassigned = 0
  for (const s of statements) {
    if (STATEMENT_EXCLUDED.has(s.status)) continue
    const per = new Map<string, { total: number; done: number }>()
    for (const sec of s.sections) {
      if (!sec.clinicId) continue
      const p = per.get(sec.clinicId) ?? { total: 0, done: 0 }
      p.total++
      if (sec.status === 'CONFIRMED') p.done++
      per.set(sec.clinicId, p)
    }
    if (per.size === 0) {
      const home = s.clinicId ?? s.uploadClinicId
      if (!home) { unassigned++; continue }
      per.set(home, { total: 0, done: 0 })
    }
    for (const [clinicId, p] of per) {
      const c = get(clinicId)
      const state: ProgState = p.total > 0 && p.done === p.total ? 'RECONCILED' : p.done > 0 ? 'IN_PROGRESS' : 'OPEN'
      if (state === 'RECONCILED') c.reconciled++
      else if (state === 'IN_PROGRESS') c.inProgress++
      else c.open++
      if (s.labId) covered.add(`${clinicId}|${s.labId}`)
    }
  }
  for (const cost of costs) {
    const k = `${cost.clinicId}|${cost.labId}`
    if (covered.has(k)) continue
    const c = get(cost.clinicId)
    if (!c.missingLabIds.includes(cost.labId)) c.missingLabIds.push(cost.labId)
  }
  return { clinics: [...byClinic.values()], unassigned }
}

/** 預設月份 = 上個月（9 月嘅月結單通常 10 月先到） */
export function lastMonthOf(todayHK: string): string {
  const [y, m] = todayHK.slice(0, 7).split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

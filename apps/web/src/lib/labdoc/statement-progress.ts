/**
 * ★ cwm-labstmtprog-20261012：Lab 月結單 —— 某月逐間診所「已對／對數中／未對／未收到」（純函數）
 *
 * 一份月結單可以有幾段（每段 = 診所 × 醫生）；按「呢份單喺呢間診所嘅段」計：
 *   全部段 CONFIRMED = 已對；部分 = 對數中；一段都未確認（或者未分段）= 未對。
 *   一份單跨幾間診所 → 每間各計一次。已作廢／重複／已取代唔計。
 *   未分段（讀緊／待確認）→ 歸單頭診所，冇就歸上傳店；都冇 → unassigned（唔知邊間店）。
 * 未收到（老闆 2026-10-12 要）：嗰間診所嗰個月有 Lab 成本（CostCase LAB，未作廢），
 *   但冇嗰間 Lab 嘅月結單（喺嗰間診所有段／單頭係嗰間）→ 列 Lab 名。
 * ★ 2026-10-12（用家拍板）：卡片逐項列「Lab × 醫生」（todo）—
 *   未對 = 未確認嘅段（邊間 Lab、邊位醫生、差幾多）；未收到 = 改按 Lab × 醫生計
 *   （一間 Lab 分開醫生出單，之前只睇 Lab 會漏）。段未揀醫生／單未分段 → 當成嗰間 Lab 喺嗰間店全部醫生都有單（唔誤報未收到）。
 */
export const STATEMENT_EXCLUDED = new Set(['VOID', 'SUPERSEDED', 'DUPLICATE'])

export interface ProgStatementIn {
  id: string
  labId: string | null
  status: string
  clinicId: string | null
  uploadClinicId: string | null
  sections: Array<{ clinicId: string | null; status: string; id?: string; providerId?: string | null; diff?: number | null }>
}
export interface ProgCostIn { clinicId: string; labId: string; providerId?: string | null }

/** 卡片逐項：OPEN = 未對（段未確認／單未分段）；MISSING = 未收到（有成本冇月結單） */
export interface ProgTodo {
  kind: 'OPEN' | 'MISSING'
  labId: string | null
  providerId: string | null
  docId?: string
  sectionId?: string
  /** 段對數差額（月結單 − 成本）；未對數 = null */
  diff?: number | null
}

export type ProgState = 'RECONCILED' | 'IN_PROGRESS' | 'OPEN'

export interface ClinicProgress {
  clinicId: string
  reconciled: number
  inProgress: number
  open: number
  /** 有成本但未收到月結單嘅 Lab（labId） */
  missingLabIds: string[]
  /** 逐項：邊間 Lab × 邊位醫生 未對／未收到 */
  todo: ProgTodo[]
}

export function statementProgress(statements: ProgStatementIn[], costs: ProgCostIn[]): { clinics: ClinicProgress[]; unassigned: number } {
  const byClinic = new Map<string, ClinicProgress>()
  const get = (clinicId: string) => {
    let c = byClinic.get(clinicId)
    if (!c) { c = { clinicId, reconciled: 0, inProgress: 0, open: 0, missingLabIds: [], todo: [] }; byClinic.set(clinicId, c) }
    return c
  }
  const covered = new Set<string>() // `${clinicId}|${labId}`（嗰間 Lab 喺嗰間店全部醫生）
  const coveredDoc = new Set<string>() // `${clinicId}|${labId}|${providerId}`
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
      get(home).todo.push({ kind: 'OPEN', labId: s.labId, providerId: null, docId: s.id, diff: null })
    } else {
      for (const sec of s.sections) {
        if (!sec.clinicId) continue
        if (s.labId) {
          if (sec.providerId) coveredDoc.add(`${sec.clinicId}|${s.labId}|${sec.providerId}`)
          else covered.add(`${sec.clinicId}|${s.labId}`)
        }
        if (sec.status !== 'CONFIRMED') {
          get(sec.clinicId).todo.push({ kind: 'OPEN', labId: s.labId, providerId: sec.providerId ?? null, docId: s.id, sectionId: sec.id, diff: sec.diff ?? null })
        }
      }
    }
    for (const [clinicId, p] of per) {
      const c = get(clinicId)
      const state: ProgState = p.total > 0 && p.done === p.total ? 'RECONCILED' : p.done > 0 ? 'IN_PROGRESS' : 'OPEN'
      if (state === 'RECONCILED') c.reconciled++
      else if (state === 'IN_PROGRESS') c.inProgress++
      else c.open++
      // 未分段 → 當成嗰間 Lab 喺嗰間店全部醫生都有單
      if (s.labId && s.sections.length === 0) covered.add(`${clinicId}|${s.labId}`)
    }
  }
  const seenMissing = new Set<string>()
  for (const cost of costs) {
    if (covered.has(`${cost.clinicId}|${cost.labId}`)) continue
    if (cost.providerId && coveredDoc.has(`${cost.clinicId}|${cost.labId}|${cost.providerId}`)) continue
    if (!cost.providerId && [...coveredDoc].some((k) => k.startsWith(`${cost.clinicId}|${cost.labId}|`))) continue
    const c = get(cost.clinicId)
    if (!c.missingLabIds.includes(cost.labId)) c.missingLabIds.push(cost.labId)
    const mk = `${cost.clinicId}|${cost.labId}|${cost.providerId ?? ''}`
    if (seenMissing.has(mk)) continue
    seenMissing.add(mk)
    c.todo.push({ kind: 'MISSING', labId: cost.labId, providerId: cost.providerId ?? null })
  }
  return { clinics: [...byClinic.values()], unassigned }
}

/** 預設月份 = 上個月（9 月嘅月結單通常 10 月先到） */
export function lastMonthOf(todayHK: string): string {
  const [y, m] = todayHK.slice(0, 7).split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

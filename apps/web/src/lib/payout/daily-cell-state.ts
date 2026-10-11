// ============================================================
// ★ cwm-dailyv2-20261007 ④：每日大數逐格核對 —— 純函數（狀態判斷）
//   ⚠️ 呢個檔唔准 import prisma（client bundle 同 CI test 都要用 — 同 daily-state 同一條紀律）
//   寫入邏輯（upsert/delete + AuditLog）喺 daily-cell-check.ts。
// ============================================================

export type CellState = 'OPEN' | 'OK' | 'CHANGED' | 'STALE'

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * 格仔狀態（純函數）：
 *   - OPEN    = 有數未 tick
 *   - OK      = 已 tick 同額（綠底 ✓）
 *   - CHANGED = 已 tick 但金額變咗（紅框、半勾、tooltip「核對後有變」；再剔 = 新金額覆寫）
 *   - STALE   = 已 tick 但數變咗 0 / 格消失（紅框「已 tick 但而家冇數」，等人取消）
 * current = 而家報表該格金額（0 / null / undefined 都算「冇數」）
 * checked = tick 紀錄嘅金額快照；null = 未 tick
 */
export function cellState(current: number | null | undefined, checked: number | null | undefined): CellState {
  if (checked == null) return 'OPEN'
  const now = current == null ? 0 : round2(current)
  if (now === 0) return 'STALE'
  return Math.abs(now - round2(checked)) > 0.005 ? 'CHANGED' : 'OK'
}

/** 「有數先有格」：0 或 null 唔出 checkbox（TOTAL 欄／Total 行／SP 筆數欄係合計，前端唔會 call 呢度） */
export function cellTickable(current: number | null | undefined): boolean {
  return current != null && round2(current) !== 0
}

// ============================================================
// ★ cwm-storedoc-20261011（方案一）：格分三組 —— 跟付款方式規則兩個旗（colKey 嘅 s／d）
//   STORE       = 計店舖營收（店✓，不論醫）→ 護士主進度、「確認核對」未對格數
//   DOCTOR_ONLY = 唔計店舖、計醫生（例如 Free SP）→ 另一條進度（紫色）
//   NONE        = 兩樣都唔計（例如 Credit）→ 有格可剔（老闆要），但唔入任何進度
// ============================================================
export type CellGroup = 'STORE' | 'DOCTOR_ONLY' | 'NONE'

export function cellGroupOf(m: { storeIncome: boolean; doctorIncome: boolean }): CellGroup {
  return m.storeIncome ? 'STORE' : m.doctorIncome ? 'DOCTOR_ONLY' : 'NONE'
}

/** 欄名下面嘅細字：店✓ 醫✓ ／ 店✗ 醫✓ … */
export function cellFlagText(m: { storeIncome: boolean; doctorIncome: boolean }): string {
  return `店${m.storeIncome ? '✓' : '✗'} 醫${m.doctorIncome ? '✓' : '✗'}`
}

export interface Prog { done: number; total: number }
export interface ProgressCell { storeIncome: boolean; doctorIncome: boolean; current: number | null | undefined; checked: number | null | undefined }

const tally = (cells: ProgressCell[], pick: (c: ProgressCell) => boolean): Prog => {
  let done = 0
  let total = 0
  for (const c of cells) {
    if (!pick(c) || !cellTickable(c.current)) continue
    total++
    if (cellState(c.current, c.checked) === 'OK') done++
  }
  return { done, total }
}

/** 核對框兩條進度（＋兩樣都唔計嘅格，只作顯示）。有變（CHANGED）唔算已對。 */
export function cellProgressOf(cells: ProgressCell[]): { store: Prog; doctorOnly: Prog; none: Prog } {
  return {
    store: tally(cells, c => cellGroupOf(c) === 'STORE'),
    doctorOnly: tally(cells, c => cellGroupOf(c) === 'DOCTOR_ONLY'),
    none: tally(cells, c => cellGroupOf(c) === 'NONE'),
  }
}

/** 一行嘅細字：店 = 店✓ 嘅格；醫 = 醫✓ 嘅格（Free SP 只入醫） */
export function rowCellProgressOf(cells: ProgressCell[]): { store: Prog; doctor: Prog } {
  return {
    store: tally(cells, c => c.storeIncome),
    doctor: tally(cells, c => c.doctorIncome),
  }
}

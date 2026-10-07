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

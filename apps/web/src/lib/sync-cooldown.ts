/**
 * ★ cw-pta: 「立即同步」掣 — 按 userId 嘅 60s cooldown（純邏輯，可測試）
 * trace: cw-pta-20260821-a1 | Spec: 醫生時間表合併 spec §3.1（拍板②：1 分鐘 cooldown）
 *
 * - 按 userId 唔按 IP —— 同一部機幾個人用唔會互相擋。
 * - Map 由 caller 持有（route 模組級 = 記憶體 cooldown；server 重啟清空，可接受）。
 * - ★ `Map.set` 要喺 sync 之前做（caller 責任）—— 放後面嘅話 sync 期間狂撳會併發打 Apricot。
 */

export const SYNC_COOLDOWN_MS = 60_000

export interface CooldownDecision {
  allowed: boolean
  /** blocked 時嘅剩餘毫秒（給 429 retryAfterMs 用） */
  retryAfterMs?: number
}

/**
 * 判斷某 userId 而家可以唔可以同步。
 * @param lastAtMap userId → 上次 sync 時間戳（ms）
 * @param userId
 * @param now       Date.now()（inject 入嚟方便測試）
 */
export function checkCooldown(
  lastAtMap: Map<string, number>,
  userId: string,
  now: number,
): CooldownDecision {
  const prev = lastAtMap.get(userId) ?? 0
  const left = SYNC_COOLDOWN_MS - (now - prev)
  return left > 0 ? { allowed: false, retryAfterMs: left } : { allowed: true }
}

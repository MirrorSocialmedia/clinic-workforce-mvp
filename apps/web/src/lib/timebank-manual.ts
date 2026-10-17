// ============================================================
// ★ cwm-tbmanual-20261017 ①：時間帳戶手動調整 —— 輸入驗證（純函數，易測）
//   同初始化（INIT_ADJUST）唔同：手動調整係【累加】，每次一行，唔刪舊嘅。
//   錄錯唔准刪除 —— 喺帳本行「撤銷」自動寫一行相反數（reversesEntryId 連結）。
//
//   驗證教訓（PR #81）：minutes 只收 number 或數字字串 ——
//   唔收 `[5]`、`{valueOf}`（object 會經 String() 變成 "5" 或 garbage）。
// ============================================================

/** |分鐘| 超過呢個數要前端「再確認一次」（老細拍板：超過 8 小時要再確認，冇上限） */
export const MANUAL_CONFIRM_THRESHOLD_MIN = 480

/** 防打錯嘅硬上限（MD §1.4） */
const MANUAL_MINUTES_CAP = 1_000_000

export type ManualAdjustInput = {
  employeeId: string
  minutes: number
  effectiveMonth: string // 'YYYY-MM'
  reason: string         // trim 後 1–200 字
  confirmLarge?: boolean
}

export type ManualAdjustValidationError =
  | { ok: false; status: 400 | 409; code: 'BAD_INPUT' | 'CONFIRM_REQUIRED'; error: string }

export type ManualAdjustValidation =
  | { ok: true; value: ManualAdjustInput }
  | ManualAdjustValidationError

/** 合法月份：'YYYY-MM'（1–12 月） */
export const MANUAL_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/

/**
 * 驗證手動調整輸入（MD §1.4 逐字）。
 * - employeeId：非空字串
 * - minutes：只接受 number 或數字字串；Number.isInteger 而且 ≠ 0；|minutes| ≤ 1,000,000
 * - effectiveMonth：/^\d{4}-(0[1-9]|1[0-2])$/
 * - reason：trim 之後 1–200 字
 * - |minutes| > 480 而 confirmLarge !== true → 409 CONFIRM_REQUIRED
 *   （前端收到彈確認框，再送一次帶 confirmLarge: true）
 */
export function validateManualAdjust(body: unknown): ManualAdjustValidation {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '請求體必須係 JSON object' }
  }
  const b = body as Record<string, unknown>

  const employeeId = typeof b.employeeId === 'string' ? b.employeeId.trim() : ''
  if (!employeeId) {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '需要選擇員工' }
  }

  // ★ minutes：number 或數字字串（唔收 [5]／{valueOf}／null／undefined）
  const rawMinutes = b.minutes
  if (typeof rawMinutes !== 'number' && typeof rawMinutes !== 'string') {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '分鐘必須係整數字' }
  }
  const minutes = typeof rawMinutes === 'number' ? rawMinutes : Number(rawMinutes)
  if (!Number.isInteger(minutes)) {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '分鐘必須係整數字' }
  }
  if (minutes === 0) {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '分鐘唔可以係 0' }
  }
  if (Math.abs(minutes) > MANUAL_MINUTES_CAP) {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '分鐘超過上限（±1,000,000），請檢查' }
  }

  const effectiveMonth = typeof b.effectiveMonth === 'string' ? b.effectiveMonth : ''
  if (!MANUAL_MONTH_RE.test(effectiveMonth)) {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '計入月份格式必須係 YYYY-MM' }
  }

  const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
  if (reason.length < 1 || reason.length > 200) {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '原因必填（1–200 字）' }
  }

  if (Math.abs(minutes) > MANUAL_CONFIRM_THRESHOLD_MIN && b.confirmLarge !== true) {
    return {
      ok: false, status: 409, code: 'CONFIRM_REQUIRED',
      error: `今次調整超過 8 小時（${Math.abs(minutes)} 分鐘），請再確認一次`,
    }
  }

  return { ok: true, value: { employeeId, minutes, effectiveMonth, reason, confirmLarge: b.confirmLarge === true } }
}

/**
 * 撤銷輸入驗證：entryId 非空字串；reason 可選（trim 後 ≤ 200 字）。
 */
export function validateManualReverse(body: unknown):
  | { ok: true; value: { entryId: string; reason: string } }
  | { ok: false; status: 400; code: 'BAD_INPUT'; error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '請求體必須係 JSON object' }
  }
  const b = body as Record<string, unknown>
  const entryId = typeof b.entryId === 'string' ? b.entryId.trim() : ''
  if (!entryId) {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '需要 entryId' }
  }
  const reason = typeof b.reason === 'string' ? b.reason.trim() : ''
  if (reason.length > 200) {
    return { ok: false, status: 400, code: 'BAD_INPUT', error: '原因最多 200 字' }
  }
  return { ok: true, value: { entryId, reason } }
}

/** 分鐘 → 「+9 小時 0 分」／「−1 小時 5 分」／「+30 分鐘」（永遠顯示小時＋分鐘） */
export function fmtManualMinutes(n: number): string {
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  const a = Math.abs(Math.round(n))
  if (a < 60) return `${sign}${a} 分鐘`
  const h = Math.floor(a / 60), m = a % 60
  return `${sign}${h} 小時 ${m} 分`
}

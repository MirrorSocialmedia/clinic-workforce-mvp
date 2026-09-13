/**
 * ★ cwm-slotsafe-resigned-20260913：query boolean 統一解析。
 *   點解要：同一個 route 入面 `all === '1'` 同 `includeResigned === 'true'` 並存，
 *   前端寫 `=1` 就靜靜失效（「顯示已離職」壞咗一直冇人為意）。
 *   一律接受 1 / true / yes（大小寫唔理）。
 */
export function boolParam(sp: URLSearchParams, key: string): boolean {
  const v = (sp.get(key) ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

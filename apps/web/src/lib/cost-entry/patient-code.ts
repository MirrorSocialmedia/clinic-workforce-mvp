/**
 * cwm-labdoc P2 — §6.5 病人編號正規化（B13）。
 *
 * `normPatientCode(raw, invoiceClinicShortName)`：
 *   1. raw 轉大階、去空格同 `#`（＋全形數字轉半形 — 保守補強，跟 §6.4 單號同精神）。
 *   2. `^([A-Z]{1,4})0*(\d{1,6})$` → 前綴 + 數字補零到 6 位（`TY9845` → `TY009845`）。
 *   3. `^\d{1,6}$` → invoice 診所 shortName + 補零 6 位（`7159` @大圍 → `TW007159`）。
 *      shortName 唔係英文字母（例「青」）→ 回 null（唔自動配對）。
 *   4. 其他 → null。
 *
 * CostCase 用同一個 function 計 patientCodeNorm（§13：POST/PUT 寫入 + backfill — 本 P2 範圍）。
 * Lab 側同成本側用同一個函數 = 配對基礎（§7.2）。
 */

/** 全形數字 → 半形 */
function toHalfDigits(s: string): string {
  return s.replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
}

export function normPatientCode(raw: string | null | undefined, clinicShortName: string | null | undefined): string | null {
  if (raw == null) return null
  const s = toHalfDigits(String(raw)).replace(/[\s#]/g, '').toUpperCase()
  if (s === '') return null
  // 規則 2：字母前綴（1-4 位）+ 純數字（1-6 位）
  const m = /^([A-Z]{1,4})0*(\d{1,6})$/.exec(s)
  if (m) {
    return `${m[1]}${m[2].padStart(6, '0')}`
  }
  // 規則 3：純數字（1-6 位）→ 診所 shortName 前綴
  if (/^\d{1,6}$/.test(s)) {
    const short = normShortName(clinicShortName)
    if (short != null) return `${short}${s.padStart(6, '0')}`
    return null // shortName 唔係英文字母（例「青」）→ 唔自動配對
  }
  // 規則 4：其他
  return null
}

/** 診所 shortName 淨化：trim + upper；唔係純英文字母（例「青」）→ null（§6.5 規則 3） */
export function normShortName(s: string | null | undefined): string | null {
  if (s == null) return null
  const t = String(s).trim().toUpperCase()
  return /^[A-Z]{1,6}$/.test(t) ? t : null
}

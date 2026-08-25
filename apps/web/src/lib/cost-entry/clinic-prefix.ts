// ============================================================
// clinic-prefix — 由病人編號前綴推診所（2026-08-25 拍板⑤）
//
// ★ 由長到短排序 —— T 開頭有三個（TY / TW / TKW），
//   短簡稱先 match 就會搶咗長簡稱（TKW002004 必須推 TKW 唔係 TW）。
// ⚠️ 推唔到回 null —— 唔好亂填，留空叫用戶自己揀。
// ⚠️ 呢度係「建議」唔係「自動填死」—— 用戶搵到可以改。
// ============================================================

export type PrefixClinic = { id: string; shortName: string | null }

/**
 * 由病人編號前綴推診所（TW007446 → 大圍）。
 * ★ 由長到短排序 match —— 長簡稱優先。
 * @returns 命中嘅 clinic id；推唔到回 null
 */
export function guessClinicByPatientCode(
  patientCode: string,
  clinics: PrefixClinic[],
): string | null {
  const code = (patientCode ?? '').trim().toUpperCase()
  if (!code) return null
  const sorted = [...clinics]
    .filter(c => c.shortName)
    .sort((a, b) => (b.shortName!.length) - (a.shortName!.length))
  const hit = sorted.find(c => code.startsWith(c.shortName!.toUpperCase()))
  return hit?.id ?? null
}

/**
 * 返返命中嘅前綴（shortName，已 upper）—— 俾 UI 顯示
 * 「✓ 由病人編號「TW」推斷，可自行更改」。
 * @returns 命中的 shortName；推唔到回 null
 */
export function matchClinicPrefix(
  patientCode: string,
  clinics: PrefixClinic[],
): string | null {
  const code = (patientCode ?? '').trim().toUpperCase()
  if (!code) return null
  const sorted = [...clinics]
    .filter(c => c.shortName)
    .sort((a, b) => (b.shortName!.length) - (a.shortName!.length))
  const hit = sorted.find(c => code.startsWith(c.shortName!.toUpperCase()))
  return hit?.shortName?.toUpperCase() ?? null
}

/**
 * 手動新增揀病人後嘅 form 更新邏輯（純函數，可測試）。
 * ★ 只喺推到、而且用戶未揀過診所時填 —— 唔好覆蓋人手選擇（驗收 #18）。
 */
export function applyPatientPick(args: {
  prevClinicId: string
  patientCode: string
  patientName: string
  clinics: PrefixClinic[]
}): {
  patientCode: string
  patientName: string
  clinicId: string
  /** 呢次係唔係由前綴推斷填咗診所（UI 顯示提示用） */
  guessed: boolean
  /** 推斷用咗嘅前綴（例如 'TW'）；唔係推斷就 null */
  prefix: string | null
} {
  const { prevClinicId, patientCode, patientName, clinics } = args
  const guessedId = guessClinicByPatientCode(patientCode, clinics)
  const applied = guessedId != null && !prevClinicId
  return {
    patientCode,
    patientName,
    clinicId: applied ? guessedId! : prevClinicId,
    guessed: applied,
    prefix: applied ? matchClinicPrefix(patientCode, clinics) : null,
  }
}

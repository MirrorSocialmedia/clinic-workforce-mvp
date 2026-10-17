// ============================================================
// ★ cwi-patient-identify-probe-20261017：Apricot 病人搜尋「用電話搵唔搵到」探測（唯讀）
//
// 目的：新客／舊客判定方案要知 Apricot clinic-patients?keyword= 搜唔搜到電話、
//   要用邊種寫法搜、病人檔電話欄實際係咩格式。呢度只做純函數：
//   ① 由一個號碼砌出多種搜尋寫法（香港 8 位／852／+852／空格／橫線；內地 11 位／86／+86）
//   ② 比對 Apricot 回嘅電話欄係咪同一個號碼（唔理格式）
//   ③ 將電話欄變成「格式形狀」（數字 → d），例如「dddd dddd」— 唔含任何真實數字
// 🔴 輸出（route）只回筆數、形狀、欄位名 — 零病人資料。
// ============================================================

export type PhoneKind = 'HK' | 'CN' | 'OTHER'

export interface ProbeTarget {
  kind: PhoneKind
  /** 比對用：HK = 8 位本地號；CN = 11 位手機號；OTHER = 全部數字 */
  core: string
}

/** 輸入號碼（任何寫法）→ 比對目標；認唔到 → null */
export function probeTarget(raw: string): ProbeTarget | null {
  const d = raw.replace(/\D/g, '')
  if (/^852[2-9]\d{7}$/.test(d)) return { kind: 'HK', core: d.slice(3) }
  if (/^[2-9]\d{7}$/.test(d)) return { kind: 'HK', core: d }
  if (/^861\d{10}$/.test(d)) return { kind: 'CN', core: d.slice(2) }
  if (/^1\d{10}$/.test(d)) return { kind: 'CN', core: d }
  if (/^\d{8,15}$/.test(d)) return { kind: 'OTHER', core: d }
  return null
}

/** 一個號碼嘅多種搜尋寫法（去重；順序 = 最可能嘅先） */
export function phoneSearchVariants(t: ProbeTarget): string[] {
  const c = t.core
  const out =
    t.kind === 'HK'
      ? [c, `${c.slice(0, 4)} ${c.slice(4)}`, `${c.slice(0, 4)}-${c.slice(4)}`, `852${c}`, `+852${c}`, `+852 ${c}`, `+852 ${c.slice(0, 4)} ${c.slice(4)}`]
      : t.kind === 'CN'
        ? [c, `86${c}`, `+86${c}`, `+86 ${c}`, `${c.slice(0, 3)} ${c.slice(3, 7)} ${c.slice(7)}`, `+86 ${c.slice(0, 3)} ${c.slice(3, 7)} ${c.slice(7)}`]
        : [c, `+${c}`]
  return [...new Set(out)]
}

/** Apricot 病人 → 所有電話字串（phoneNum + phoneList[].number；欄位名唔肯定 → 兩種都試） */
export function patientPhoneStrings(p: any): string[] {
  const out: string[] = []
  for (const k of ['phoneNum', 'phone', 'mobile', 'mobileNo', 'telNo']) {
    if (typeof p?.[k] === 'string' && p[k].trim()) out.push(p[k])
  }
  const list = Array.isArray(p?.phoneList) ? p.phoneList : []
  for (const x of list) {
    const n = x?.number ?? x?.phoneNum ?? x?.value
    if (typeof n === 'string' && n.trim()) out.push(n)
  }
  return out
}

/** 一個電話欄（可能多號：「9123 4567 / 6123 4567」）有冇包含目標號碼（唔理空格／橫線／國碼） */
export function phoneFieldMatches(field: string, t: ProbeTarget): boolean {
  const len = t.kind === 'HK' ? 8 : t.kind === 'CN' ? 11 : t.core.length
  // 先按明確分隔符拆；每段去晒非數字再睇尾 N 位
  for (const seg of field.split(/[\/,;、|]+/)) {
    const d = seg.replace(/\D/g, '')
    if (d.length >= len && d.slice(-len) === t.core) return true
  }
  // 再試成欄（有人用空格分隔兩個號）：逐個「連續數字＋空格／橫線」窗口
  const digits = field.replace(/[^\d]/g, ' ').split(/\s+/).filter(Boolean)
  for (let i = 0; i < digits.length; i++) {
    let acc = ''
    for (let j = i; j < digits.length && acc.length < len + 3; j++) {
      acc += digits[j]
      if (acc.length >= len && acc.slice(-len) === t.core) return true
    }
  }
  return false
}

/** 電話欄 → 格式形狀（數字變 d、保留空格／符號）— 唔含真實號碼 */
export function phoneShape(field: string): string {
  return field.trim().replace(/\d/g, 'd').slice(0, 40)
}

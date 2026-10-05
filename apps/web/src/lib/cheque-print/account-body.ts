// ★ cwm-chequeprint-20261005：出票戶口表單驗證（POST／PUT 共用）
export interface AccountData {
  label: string
  bankName: string
  accountLast4: string | null
  layoutId: string | null
  bookFirstNo: number | null
  bookLastNo: number | null
  nextNo: number | null
  noWidth: number
  isActive: boolean
  clinicIds: string[]
}

const intOrNull = (v: unknown): number | null | 'bad' => {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  return Number.isInteger(n) && n >= 0 && n < 1e9 ? n : 'bad'
}

export function parseAccountBody(b: any): { ok: true; data: AccountData } | { ok: false; error: string } {
  const label = typeof b?.label === 'string' ? b.label.trim().slice(0, 40) : ''
  if (!label) return { ok: false, error: '請填戶口名稱' }
  const last4 = typeof b?.accountLast4 === 'string' ? b.accountLast4.replace(/\D/g, '') : ''
  if (last4 && last4.length !== 4) return { ok: false, error: '戶口號碼只填尾 4 位' }
  const first = intOrNull(b?.bookFirstNo), last = intOrNull(b?.bookLastNo), next = intOrNull(b?.nextNo)
  if (first === 'bad' || last === 'bad' || next === 'bad') return { ok: false, error: '支票號碼要係數字' }
  if (first != null && last != null && last < first) return { ok: false, error: '支票簿尾張要大過首張' }
  if (next != null && first != null && next < first) return { ok: false, error: '下一張唔可以細過首張' }
  if (next != null && last != null && next > last + 1) return { ok: false, error: '下一張超出支票簿範圍' }
  const width = Number(b?.noWidth ?? 6)
  if (!Number.isInteger(width) || width < 1 || width > 10) return { ok: false, error: '號碼位數要 1–10' }
  const clinicIds = Array.isArray(b?.clinicIds) ? Array.from(new Set(b.clinicIds.filter((x: unknown) => typeof x === 'string'))) as string[] : []
  return {
    ok: true,
    data: {
      label, bankName: typeof b?.bankName === 'string' && b.bankName.trim() ? b.bankName.trim().slice(0, 20) : 'HSBC',
      accountLast4: last4 || null, layoutId: typeof b?.layoutId === 'string' && b.layoutId ? b.layoutId : null,
      bookFirstNo: first, bookLastNo: last, nextNo: next ?? first, noWidth: width, isActive: b?.isActive !== false, clinicIds,
    },
  }
}

// ============================================================
// ★ cwm-chequeprint-20261005：支票金額英文大寫（老闆：英文得）
//   例：17220 → "SEVENTEEN THOUSAND TWO HUNDRED AND TWENTY ONLY"
//       9915.5 → "NINE THOUSAND NINE HUNDRED AND FIFTEEN AND CENTS FIFTY ONLY"
//   「港幣 Hong Kong Dollars」支票本身印咗，呢度唔再加。
// ============================================================

const ONES = ['', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
  'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN', 'SEVENTEEN', 'EIGHTEEN', 'NINETEEN']
const TENS = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY']

function under100(n: number): string {
  if (n < 20) return ONES[n]
  return TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '')
}

/** 0–999；andBefore = 前面有更大單位（例 "ONE THOUSAND AND FIVE"） */
function under1000(n: number, andBefore: boolean): string {
  const h = Math.floor(n / 100)
  const r = n % 100
  const parts: string[] = []
  if (h) parts.push(ONES[h] + ' HUNDRED')
  if (r) parts.push(((h || andBefore) ? 'AND ' : '') + under100(r))
  return parts.join(' ')
}

/** 整數部分（最多 999,999,999,999） */
export function integerWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) throw new Error('金額超出範圍')
  if (n === 0) return 'ZERO'
  const units: Array<[number, string]> = [[1e9, 'BILLION'], [1e6, 'MILLION'], [1e3, 'THOUSAND'], [1, '']]
  const parts: string[] = []
  let rest = n
  for (const [size, name] of units) {
    const chunk = Math.floor(rest / size)
    rest = rest % size
    if (!chunk) continue
    const words = under1000(chunk, size === 1 && parts.length > 0)
    parts.push(name ? `${words} ${name}` : words)
  }
  return parts.join(' ')
}

/** 金額轉為「仙」整數（避免浮點誤差）；負數或 0 拋錯 */
export function toCents(amount: number | string): number {
  const v = typeof amount === 'string' ? Number(amount) : amount
  if (!Number.isFinite(v)) throw new Error('金額唔係數字')
  const cents = Math.round(v * 100)
  if (cents <= 0) throw new Error('金額要大過 0')
  return cents
}

export function amountInWords(amount: number | string): string {
  const cents = toCents(amount)
  const dollars = Math.floor(cents / 100)
  const c = cents % 100
  const d = dollars ? integerWords(dollars) : ''
  if (!c) return `${d} ONLY`
  const cw = `CENTS ${integerWords(c)}`
  return d ? `${d} AND ${cw} ONLY` : `${cw} ONLY`
}

/** 數字欄：**17,220.00** */
export function amountFigures(amount: number | string): string {
  const cents = toCents(amount)
  const d = Math.floor(cents / 100).toLocaleString('en-US')
  return `**${d}.${String(cents % 100).padStart(2, '0')}**`
}

/**
 * 將大寫分兩行（按字斷，唔斷字）；第一行頭冇星，最尾補 *** 防加字。
 * 塞唔落兩行 → null（打印中心會擋住，唔會印半句）
 */
export function splitWords(words: string, line1Chars: number, line2Chars: number): [string, string] | null {
  const tokens = words.split(' ')
  let l1 = ''
  let i = 0
  while (i < tokens.length) {
    const next = l1 ? `${l1} ${tokens[i]}` : tokens[i]
    if (next.length > line1Chars) break
    l1 = next
    i++
  }
  const l2 = tokens.slice(i).join(' ')
  if (!l2) {
    // 一行搞掂：第一行補星，第二行全星（防人加字）
    const padded = (l1 + ' ' + '*'.repeat(Math.max(0, line1Chars - l1.length - 1))).trimEnd()
    return [padded, '*'.repeat(Math.max(3, Math.min(line2Chars, 12)))]
  }
  if (!l1) return null
  const withStars = `${l2} ***`
  if (withStars.length > line2Chars) return l2.length <= line2Chars ? [l1, l2] : null
  return [l1, withStars]
}

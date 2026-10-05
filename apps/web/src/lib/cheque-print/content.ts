// ============================================================
// ★ cwm-chequeprint-20261005：由收款人＋金額＋日期砌一張支票嘅內容，順手驗證塞唔塞得落
//   v2：塞唔落就自動用細啲字距（10 → 12 → 15 cpi，只限 ESC/P）
// ============================================================
import { amountFigures, amountInWords, splitWords } from './words'
import { charsFit, cpiChoices, type ChequeContent, type Cpi, type LayoutFields, type PrinterMode } from './layout'

export const hasNonAscii = (s: string) => /[^\x20-\x7e]/.test(s)

/** 抬頭：去頭尾空白、壓縮空格、英文轉大階 */
export function cleanPayee(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toUpperCase()
}

export type BuildResult = { ok: true; content: ChequeContent } | { ok: false; error: string }

export function buildContent(input: { payee: string; amount: number | string; date: string }, f: LayoutFields, mode: PrinterMode): BuildResult {
  const payee = cleanPayee(input.payee || '')
  if (!payee) return { ok: false, error: '未有支票抬頭' }
  if (mode === 'TEXT' && hasNonAscii(payee)) return { ok: false, error: '抬頭有中文：打印機要用 ESC/P 模式先印到中文' }
  let words: string
  let figures: string
  try {
    words = amountInWords(input.amount)
    figures = amountFigures(input.amount)
  } catch (e: any) {
    return { ok: false, error: e?.message || '金額有問題' }
  }

  // 抬頭：前後加 ** 防加字；中文用點陣（闊度由瀏覽器量，呢度唔驗）
  let payeeText: string | null = null
  let payeeCpi: Cpi = f.payee.cpi
  if (hasNonAscii(payee)) {
    payeeText = `** ${payee} **`
  } else {
    outer: for (const text of [`** ${payee} **`, payee]) {
      for (const c of cpiChoices(f.payee.cpi, mode)) {
        if (text.length <= charsFit(f.payee.width, c)) { payeeText = text; payeeCpi = c; break outer }
      }
    }
    if (!payeeText) return { ok: false, error: `抬頭太長（${payee.length} 字），請喺版面調闊抬頭欄` }
  }

  let amountCpi: Cpi | null = null
  for (const c of cpiChoices(f.amount.cpi, mode)) if (figures.length <= charsFit(f.amount.width, c)) { amountCpi = c; break }
  if (!amountCpi) return { ok: false, error: '金額數字塞唔落金額格' }

  // 大寫兩行用同一個字距
  for (const c of cpiChoices(f.words1.cpi, mode)) {
    const lines = splitWords(words, charsFit(f.words1.width, c), charsFit(f.words2.width, c))
    if (lines) return { ok: true, content: { date: input.date, payee: payeeText, words: lines, figures, cpi: { payee: payeeCpi, words: c, amount: amountCpi } } }
  }
  return { ok: false, error: '英文大寫兩行都塞唔落，請喺版面調闊大寫欄' }
}

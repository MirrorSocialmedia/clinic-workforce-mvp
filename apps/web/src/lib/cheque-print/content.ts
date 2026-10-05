// ============================================================
// ★ cwm-chequeprint-20261005：由收款人＋金額＋日期砌一張支票嘅內容，順手驗證塞唔塞得落
// ============================================================
import { amountFigures, amountInWords, splitWords } from './words'
import { fieldChars, type ChequeContent, type LayoutFields, type PrinterMode } from './layout'

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
  const fit = fieldChars(f, mode)
  // 抬頭前後加 ** 防加字；塞唔落就唔加星
  const starred = `** ${payee} **`
  const payeeText = starred.length <= fit.payee ? starred : payee
  if (!hasNonAscii(payee) && payeeText.length > fit.payee) return { ok: false, error: `抬頭太長（${payee.length} 字，最多 ${fit.payee}）` }
  if (figures.length > fit.amount) return { ok: false, error: '金額數字塞唔落金額格' }
  const lines = splitWords(words, fit.words1, fit.words2)
  if (!lines) return { ok: false, error: '英文大寫兩行都塞唔落，請喺版面設定調闊或者改細字（12 cpi）' }
  return { ok: true, content: { date: input.date, payee: payeeText, words: lines, figures } }
}

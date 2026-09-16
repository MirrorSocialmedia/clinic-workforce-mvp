// ============================================================
// quote-parser — E 類報價抽取「第一層：確定性字典」（MD §5.2）
// cwi-followup-p4-20260916 S2
//
// 輸入：臨床 note 文本（diagnosis / Tx / storedTemplate blocks）+ 術語表
//   （ClinicalTermMap active 行 — caller 載入傳入，本檔純函數零 DB）。
//
// 解析規則（MD §5.3：規則本身唔可編輯 — 只詞表可改）：
//   金額：`\$?\s?(\d[\d,]*)\s?(k|K)?` — 4K→4000 / 900@→900 per unit /
//         5-6K→range(5000..6000) / 12000$→12000 / 18k→18000
//   意向詞：quoted / suggest / consider / TCA（下次覆診）→ **未做**（鐵律 §6.5）
//   牙位：FDI 兩位數 11–48（只標記唔判斷）；32-42 = FDI 範圍（展開）
//   療程詞：術語表匹配（case-insensitive，單詞 + 多詞短語）
//
// 兩層口徑：術語表命中 = certainty high；有金額但術語唔中（或整段無術語）
//   = certainty low → needsLlm=true（第二層 LLM 必須落返字典 code）。
// ============================================================

export interface TermEntry {
  shorthand: string
  nameCn: string
  nameEn: string | null
  active: boolean
}

export interface ParsedQuoteItem {
  /** 原始匹配文字（術語 shorthand 或 orphan 短句）。 */
  text: string
  /** 術語表命中嘅 shorthand；null = 術語唔中（low）。 */
  termShorthand: string | null
  /** 術語表標準名稱（顯示用）。 */
  nameCn: string | null
  amountMin: number | null
  amountMax: number | null
  perUnit: boolean
  /** FDI 11–48（範圍已展開；只標記唔判斷）。 */
  fdiTeeth: string[]
  /** not_done = quoted/suggest/consider/TCA（建議未做 — 鐵律 §6.5）。 */
  intent: 'not_done' | 'unknown'
  certainty: 'high' | 'low'
}

export interface ParsedQuote {
  raw: string
  items: ParsedQuoteItem[]
  /** 有 low 信心項 → 落第二層 LLM。 */
  needsLlm: boolean
}

// ── 規則常數（MD §5.3：唔可編輯 — 只詞表可改）──────────────────────────
const INTENT_RE = /\b(quoted|suggest|consider|tca)\b/i
// 「or/and」唔分割（"quoted br ... or implant ..." — intent 要傳播過兩個選項；
//   金額/牙位照樣按最近距離歸項）
const SEGMENT_SPLIT = /\r?\n|;|·|•|…|\.{3}|\/(?=\s*[A-Za-z0-9])/
const PER_UNIT_RE = /\b(per\s+unit|each)\b/i
const FDIs = (n: number): boolean => n >= 11 && n <= 48

interface AmountTok { value: number; perUnit: boolean; min?: number; max?: number; start: number; end: number }
interface FdiTok { tooth: string; start: number; end: number; expanded: string[] }

// 金額抽取（位置精確版 — 逐個 regex 跑原串，唔用 placeholder 對齊）：
// 順序：range-K → 數字範圍 → K → $後 → $前 → @ → 裸 3+ 位。已消費區間唔重疊。
function extractAmounts(s: string): AmountTok[] {
  const out: AmountTok[] = []
  const taken: [number, number][] = []
  const overlap = (a: number, b: number) => taken.some(([x, y]) => a < y && b > x)
  const push = (start: number, end: number, tok: Omit<AmountTok, 'start' | 'end'>) => {
    if (overlap(start, end)) return
    taken.push([start, end])
    out.push({ ...tok, start, end })
  }

  // 1) 5-6K / 5000-6000K?（K 範圍）
  for (const m of s.matchAll(/(\d[\d,]*)\s*[-–~]\s*(\d[\d,]*)\s*[kK]\b/g)) {
    const min = parseInt(m[1].replace(/,/g, ''), 10) * 1000
    const max = parseInt(m[2].replace(/,/g, ''), 10) * 1000
    push(m.index!, m.index! + m[0].length, { value: min, min, max, perUnit: false })
  }
  // 2) 數字範圍（無 K）— 只係兩個端都唔係 FDI 先當金額範圍（FDI 範圍另計）
  for (const m of s.matchAll(/\b(\d{3,}[\d,]*)\s*[-–~]\s*(\d{3,}[\d,]*)\b/g)) {
    const min = parseInt(m[1].replace(/,/g, ''), 10)
    const max = parseInt(m[2].replace(/,/g, ''), 10)
    push(m.index!, m.index! + m[0].length, { value: min, min, max, perUnit: false })
  }
  // 3) 4K / 18k
  for (const m of s.matchAll(/\b(\d[\d,]*)\s*[kK]\b/g)) {
    push(m.index!, m.index! + m[0].length, { value: parseInt(m[1].replace(/,/g, ''), 10) * 1000, perUnit: false })
  }
  // 4) 12000$ / $12000
  for (const m of s.matchAll(/\b(\d[\d,]{2,})\s*\$/g)) {
    push(m.index!, m.index! + m[0].length, { value: parseInt(m[1].replace(/,/g, ''), 10), perUnit: false })
  }
  for (const m of s.matchAll(/\$\s*(\d[\d,]{2,})\b/g)) {
    push(m.index!, m.index! + m[0].length, { value: parseInt(m[1].replace(/,/g, ''), 10), perUnit: false })
  }
  // 5) 900@
  for (const m of s.matchAll(/\b(\d[\d,]*)\s*[@＠]/g)) {
    push(m.index!, m.index! + m[0].length, { value: parseInt(m[1].replace(/,/g, ''), 10), perUnit: true })
  }
  // 6) 裸 3+ 位數字（5500）— 1-2 位唔算金額（FDI／數量）
  for (const m of s.matchAll(/\b(\d{3}[\d,]*)\b/g)) {
    push(m.index!, m.index! + m[0].length, { value: parseInt(m[1].replace(/,/g, ''), 10), perUnit: false })
  }
  out.sort((a, b) => a.start - b.start)
  return out
}

// FDI 抽取（金額區間先剔走 — 避免 12000 入面嘅 20/00 誤判）
function extractFdi(s: string, amounts: AmountTok[]): FdiTok[] {
  const out: FdiTok[] = []
  const inAmount = (i: number) => amounts.some((a) => i >= a.start && i < a.end)
  // 1) 範圍 32-42（兩端 11–48）→ 展開
  for (const m of s.matchAll(/\b(\d{2})\s*[-–~]\s*(\d{2})\b/g)) {
    const i = m.index!
    if (inAmount(i)) continue
    const a = parseInt(m[1], 10), b = parseInt(m[2], 10)
    if (FDIs(a) && FDIs(b) && b >= a && b - a <= 37) {
      const teeth: string[] = []
      for (let t = a; t <= b; t++) teeth.push(String(t))
      out.push({ tooth: m[0], start: i, end: i + m[0].length, expanded: teeth })
    }
  }
  // 2) 獨立 11–48（唔喺範圍／金額入面）
  for (const m of s.matchAll(/\b(\d{2})\b/g)) {
    const i = m.index!
    if (inAmount(i)) continue
    if (out.some((f) => i >= f.start && i < f.end)) continue
    const n = parseInt(m[1], 10)
    if (FDIs(n)) out.push({ tooth: m[1], start: i, end: i + m[0].length, expanded: [m[1]] })
  }
  return out
}

// 術語匹配（word-boundary；多詞短語同單詞同款 — phrase 本身即邊界）
function findTermHits(s: string, terms: TermEntry[]): { shorthand: string; nameCn: string; start: number; end: number }[] {
  const lower = s.toLowerCase()
  const hits: { shorthand: string; nameCn: string; start: number; end: number }[] = []
  const active = terms.filter((t) => t.active)
  for (const t of active) {
    const ph = t.shorthand.toLowerCase()
    let idx = lower.indexOf(ph)
    while (idx !== -1) {
      const before = idx === 0 ? '' : lower[idx - 1]
      const after = idx + ph.length >= lower.length ? '' : lower[idx + ph.length]
      // word boundary：前後唔好係字母/數字（hyphen 容許：32-42 唔係術語場景，但 anti-snoring 類容許）
      const okB = before === '' || !/[a-z0-9]/.test(before)
      const okA = after === '' || !/[a-z0-9]/.test(after)
      if (okB && okA) hits.push({ shorthand: t.shorthand, nameCn: t.nameCn, start: idx, end: idx + ph.length })
      idx = lower.indexOf(ph, idx + ph.length)
    }
  }
  // 重叠剔除：長短語優先（ANTI SNORING DEVICE > SNORING? — 表中無單詞版；防御性保留）
  hits.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
  const chosen: typeof hits = []
  for (const h of hits) {
    if (chosen.some((c) => h.start < c.end && h.end > c.start)) continue
    chosen.push(h)
  }
  return chosen.sort((a, b) => a.start - b.start)
}

function nearest<T extends { start: number; end: number }>(pos: number, cands: T[]): T | null {
  if (!cands.length) return null
  return cands.reduce((best, c) => {
    const d = (p: number) => (p < c.start ? c.start - p : p > c.end ? p - c.end : 0)
    const db = (p: number) => (p < best.start ? best.start - p : p > best.end ? p - best.end : 0)
    return d(pos) <= db(pos) ? c : best
  })
}

// ── 主入口 ────────────────────────────────────────────────────────────
export function parseQuote(raw: string, terms: TermEntry[]): ParsedQuote {
  const items: ParsedQuoteItem[] = []
  if (!raw || !raw.trim()) return { raw: raw ?? '', items, needsLlm: false }

  // TCA 特殊規則（MD §5.2 意向詞：下次覆診）— per-segment：段內只有 TCA = 獨立項

  for (const segRaw of raw.split(SEGMENT_SPLIT)) {
    const seg = segRaw.trim()
    if (!seg) continue

    const intent: ParsedQuoteItem['intent'] = INTENT_RE.test(seg) ? 'not_done' : 'unknown'
    const amounts = extractAmounts(seg)
    const fdis = extractFdi(seg, amounts)
    const termHits = findTermHits(seg, terms)

    const perUnitSeg = PER_UNIT_RE.test(seg)

    // 每項 = 術語 hit（或多個 hit 各一項）；金額/FDI 按最近距離歸項
    const mkItem = (
      base: { text: string; termShorthand: string | null; nameCn: string | null; certainty: 'high' | 'low' },
      aStart: number,
      aEnd: number,
    ): ParsedQuoteItem => {
      // 金額歸項（clinic 語法 — 金額跟術語後："br per unit 5500 or implant 31 41" 5500 屬 br）：
      //   owner = 金額前最近嘅術語（exclusive — 只該術語收）；金額喺所有術語前 → 雙向最近。
      const mine = amounts.filter((a) => {
        const before = termHits.filter((h) => h.end <= a.start)
        if (before.length) return before[before.length - 1].start === aStart
        const owner = nearest((a.start + a.end) / 2, termHits)
        return owner === null || owner.start === aStart
      })
      const ft = fdis.filter((f) => {
        const mid = (f.start + f.end) / 2
        const owner = nearest(mid, termHits)
        return owner === null || Math.abs(mid - (aStart + aEnd) / 2) <= Math.abs(mid - (owner.start + owner.end) / 2)
      })
      // 同項多金額：range 優先；其次 min/max 排序（5500/18k 唔會同段 — 防御）
      const range = mine.find((a) => a.min !== undefined && a.max !== undefined && a.min !== a.max)
      const flat = mine.filter((a) => a !== range)
      const sorted = [...flat].sort((x, y) => x.value - y.value)
      const amountMin = range ? range.min : sorted.length ? sorted[0].value : null
      const amountMax = range ? range.max : sorted.length > 1 ? sorted[sorted.length - 1].value : amountMin
      return {
        text: base.text,
        termShorthand: base.termShorthand,
        nameCn: base.nameCn,
        amountMin: amountMin ?? null,
        amountMax: amountMax ?? null,
        perUnit: mine.some((a) => a.perUnit) || (perUnitSeg && mine.length > 0),
        fdiTeeth: [...new Set(ft.flatMap((f) => f.expanded))].sort(),
        intent,
        certainty: base.certainty,
      }
    }

    const segTcaOnly =
      /\bTCA\b/i.test(seg) &&
      termHits.length === 0 &&
      amounts.length === 0 &&
      fdis.length === 0 &&
      seg.replace(/\bTCA\b/gi, '').replace(/[^a-zA-Z0-9]/g, '').length === 0

    if (segTcaOnly) {
      items.push({ text: 'TCA', termShorthand: null, nameCn: '下次覆診 (TCA)', amountMin: null, amountMax: null, perUnit: false, fdiTeeth: [], intent: 'not_done', certainty: 'high' })
      continue
    }

    if (termHits.length) {
      for (const h of termHits) items.push(mkItem({ text: h.shorthand, termShorthand: h.shorthand, nameCn: h.nameCn, certainty: 'high' }, h.start, h.end))
    }

    // 金額／FDI 無主（段內無術語）→ orphan 項（low → LLM 層）
    const orphanAmounts = amounts.filter((a) => {
      const mid = (a.start + a.end) / 2
      return !termHits.some((h) => Math.abs(mid - (h.start + h.end) / 2) <= Math.abs(mid - (nearest(mid, termHits)!.start + nearest(mid, termHits)!.end) / 2))
    })
    const orphanFdis = fdis.filter((f) => {
      const mid = (f.start + f.end) / 2
      const owner = nearest(mid, termHits)
      return owner === null
    })
    if (orphanAmounts.length || orphanFdis.length) {
      const words = seg
        .replace(/\d[\d,]*\s*[-–~]?\s*\d[\d,]*\s*[kK$@]?/gi, ' ')
        .replace(/\b\d{2,}\b/g, ' ')
        .replace(/\b(quoted|suggest|consider|tca|per|unit|by|need|dr)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
      items.push(
        mkItem(
          { text: words || seg.slice(0, 40), termShorthand: null, nameCn: null, certainty: 'low' },
          -1,
          -1,
        ),
      )
    } else if (!termHits.length && !amounts.length && !fdis.length) {
      // 純文字段（無術語無金額無牙位）— 唔係報價項，唔入 items
      void seg
    }
  }

  // 同 shorthand 同段重複項合併防御（正常唔會發生）
  const dedup = new Map<string, ParsedQuoteItem>()
  for (const it of items) {
    const k = `${it.termShorthand ?? it.text}|${it.amountMin}|${it.amountMax}|${it.fdiTeeth.join(',')}`
    if (!dedup.has(k)) dedup.set(k, it)
  }

  const list = [...dedup.values()]
  return { raw, items: list, needsLlm: list.some((i) => i.certainty === 'low') }
}

// 測試輔助：清 amount/FDI token 嘅 start/end 之外只取公開欄
export type { ParsedQuoteItem as QuoteItem }

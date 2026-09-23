// ============================================================
// quote-extract — E 類報價抽取「兩層 + 存儲」（MD §5.2）
// cwi-followup-p4-20260916 S3
//
// 第一層：parseQuote 確定性字典（quote-parser.ts）
// 第二層：needsLlm 先落 LLM（本地 Qwen）— 輸出**必須落返字典 code**，
//   唔准自由發明（code 唔喺字典 → 當 null，留低低信心）。
// 第三層：低信心行落確認隊列（status=pending — W admin 頁 ✓/✎/✗）。
//
// 存儲冪等：同 sourceVisitId 重跑 = 只重建 pending 行；
//   人手決定（confirmed/corrected/discarded）行保留。
// ============================================================

import { basePrisma } from '@/lib/prisma'
import { parseQuote, type ParsedQuoteItem, type TermEntry } from './quote-parser'
import { noteTextToPlain } from './extract-rx-codes'
import { extractViaWaInbox } from './llm-client'
import type { NoteText } from '@/lib/clinical-index/types'

// ── 術語表載入（5 分鐘 in-process cache — 同 rx 口徑）────────────────────
let termCache: { at: number; rows: TermEntry[] } | null = null
const TERM_TTL_MS = 5 * 60 * 1000

export async function loadTermEntries(force = false): Promise<TermEntry[]> {
  if (!force && termCache && Date.now() - termCache.at < TERM_TTL_MS) return termCache.rows
  const rows = await basePrisma.clinicalTermMap.findMany({ where: { active: true } })
  termCache = { at: Date.now(), rows: rows.map((r) => ({ shorthand: r.shorthand, nameCn: r.nameCn, nameEn: r.nameEn, active: r.active })) }
  return termCache.rows
}

/** 測試用：清 term cache（術語表「即時生效」e2e 用） */
export function resetTermCache(): void {
  termCache = null
}

// ── 第二層：LLM ─────────────────────────────────────────────────────────
export interface LlmQuoteItem {
  text: string | null
  code: string | null // 必須喺字典；唔喺 → null
  amount: number | null
  perUnit: boolean
}

/** 解析 LLM 輸出（strip ``` fence + 只收字典 code）→ null = 失敗（低信心保留）。 */
export function parseLlmQuoteResponse(content: string, terms: TermEntry[]): LlmQuoteItem[] | null {
  try {
    let s = content.trim()
    const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s)
    if (fence) s = fence[1].trim()
    const j = JSON.parse(s) as any
    if (!Array.isArray(j?.items)) return null
    const byLower = new Map(terms.map((t) => [t.shorthand.toLowerCase(), t]))
    return j.items
      .filter((i: any) => i && typeof i === 'object')
      .slice(0, 20)
      .map((i: any) => {
        const codeRaw = typeof i.code === 'string' ? i.code.trim() : ''
        const code = byLower.has(codeRaw.toLowerCase()) ? byLower.get(codeRaw.toLowerCase())!.shorthand : null
        const amt = typeof i.amount === 'number' && Number.isFinite(i.amount) && i.amount > 0 ? Math.round(i.amount) : null
        return {
          text: typeof i.text === 'string' ? i.text.trim().slice(0, 60) : null,
          code,
          amount: amt,
          perUnit: i.perUnit === true,
        }
      })
  } catch {
    return null
  }
}

export async function runLlmLayer(
  notePlain: string,
  terms: TermEntry[],
  llmMaxAttempts?: number,
): Promise<LlmQuoteItem[] | null> {
  const items = await extractViaWaInbox(notePlain, terms, llmMaxAttempts ? { maxAttempts: llmMaxAttempts } : undefined)
  if (!items) return null
  // 雙保險：wa-inbox 已過濾，但呢度再以本地字典驗 code（唔信任 proxy 回傳）
  return parseLlmQuoteResponse(JSON.stringify({ items }), terms)
}

// ── 兩層合併 ────────────────────────────────────────────────────────────
export interface ExtractedQuote {
  text: string
  termShorthand: string | null
  nameCn: string | null
  amountMin: number | null
  amountMax: number | null
  perUnit: boolean
  fdiTeeth: string[]
  intent: 'not_done' | 'unknown'
  certainty: 'high' | 'low'
  source: 'parser' | 'llm'
}

export async function extractQuotes(note: NoteText, terms: TermEntry[], visitId?: string, opts?: { skipLlm?: boolean; llmMaxAttempts?: number }): Promise<ExtractedQuote[]> {
  const plain = noteTextToPlain(note)
  const parsed = parseQuote(plain, terms)
  const termByIdx = new Map(terms.map((t) => [t.shorthand, t]))

  const items: ExtractedQuote[] = parsed.items.map((i: ParsedQuoteItem) => ({
    text: i.text,
    termShorthand: i.termShorthand,
    nameCn: i.nameCn,
    amountMin: i.amountMin,
    amountMax: i.amountMax,
    perUnit: i.perUnit,
    fdiTeeth: i.fdiTeeth,
    intent: i.intent,
    certainty: i.certainty,
    source: 'parser' as const,
  }))

    if (parsed.needsLlm && !opts?.skipLlm) {
    const llmItems = await runLlmLayer(plain, terms, opts?.llmMaxAttempts)
    if (llmItems) {
      // LLM 補低信心 orphan（text 子串配對）+ 收 LLM 新發現
      const consumed = new Set<string>()
      for (const li of llmItems) {
        const match = items.find((it) => {
          if (consumed.has(it.text) || it.certainty !== 'low' || !li.text) return false
          const a = it.text.toLowerCase(), b = li.text.toLowerCase()
          return a.includes(b) || b.includes(a) || a.split(/\s+/).some((w) => w.length > 2 && b.includes(w))
        })
        if (match && li.code) {
          const t = termByIdx.get(li.code)
          match.termShorthand = t?.shorthand ?? null
          match.nameCn = t?.nameCn ?? match.nameCn
          match.certainty = 'high' // LLM 落返字典 code = 高信心
          if (li.amount != null && match.amountMin == null) {
            match.amountMin = li.amount
            match.amountMax = li.amount
          }
          match.perUnit = match.perUnit || li.perUnit
          match.source = 'llm'
          consumed.add(match.text)
        } else if (!match && li.code) {
          const t = termByIdx.get(li.code)!
          items.push({
            text: li.text ?? li.code,
            termShorthand: t.shorthand,
            nameCn: t.nameCn,
            amountMin: li.amount,
            amountMax: li.amount,
            perUnit: li.perUnit,
            fdiTeeth: [],
            intent: 'unknown',
            certainty: 'high',
            source: 'llm',
          })
        }
      }
    } else {
      // ★ cwi-final S0-9：LLM 層零產出 — low 項保留（落確認隊列）；visitId 係內部 id，唔係 PII
      console.info('[quote-extract] llm layer null — items kept low-certainty', { visitId, orphan: items.filter(i => i.certainty === 'low').length })
    }
    // LLM 失敗/唔中 → low 項保留（落確認隊列）
  }

  // 去重（同 text + 金額）
  const seen = new Set<string>()
  return items.filter((i) => {
    const k = `${i.text}|${i.termShorthand}|${i.amountMin}|${i.amountMax}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ── 存儲（冪等 — 只重建 pending；人手決定保留）──────────────────────────
export async function storeQuotesForVisit(opts: {
  visitId: string
  clinicId: string
  patientApricotId: string
  visitDate: Date
  note: NoteText
  /** ★ S2-9b backfill 限流：LLM quota 用完後唔再打 LLM（low 行照存 — 落確認隊列） */
  skipLlm?: boolean
  /** ★ cwm-leaveasoffix-20260923 S5-3：request path 傳 1（唔重試 429） */
  llmMaxAttempts?: number
}): Promise<{ stored: number }> {
  const terms = await loadTermEntries()
  const items = await extractQuotes(opts.note, terms, opts.visitId, { skipLlm: opts.skipLlm, llmMaxAttempts: opts.llmMaxAttempts })
  if (!items.length) {
    // 冇報價項 — 清走舊 pending（重跑口徑一致）
    await basePrisma.quotedItem.deleteMany({ where: { sourceVisitId: opts.visitId, status: 'pending' } })
    return { stored: 0 }
  }
  await basePrisma.quotedItem.deleteMany({ where: { sourceVisitId: opts.visitId, status: 'pending' } })
  await basePrisma.quotedItem.createMany({
    data: items.map((i) => ({
      clinicId: opts.clinicId,
      patientApricotId: opts.patientApricotId,
      sourceVisitId: opts.visitId,
      sourceVisitDate: opts.visitDate,
      text: i.text.slice(0, 80),
      termShorthand: i.termShorthand,
      nameCn: i.nameCn,
      amountMin: i.amountMin,
      amountMax: i.amountMax,
      perUnit: i.perUnit,
      fdiTeeth: i.fdiTeeth,
      intent: i.intent,
      certainty: i.certainty,
      source: i.source,
    })),
  })
  return { stored: items.length }
}

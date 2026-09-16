// ============================================================
// extract-rx-codes — 藥物 code 抽取（cwi-followup-p4-20260916 S4）
//
// 來源：note 文本（STANDARD: actions/findings/diagnosis；TEMPLATE: blocks）
//   對 ClinicalRxCode 字典（nameEn/nameCn，case-insensitive）匹配。
// 出口：code 陣列（入 ClinicalRecordIndex.rxCodes）— 零全文、零電話。
// C 類「rxCodes 有抗生素」判定用 ClinicalRxCode.isAntibiotic。
//
// 純函數（unit 可測）；caller（visit-index.resolvePatientDay）傳入字典。
// ============================================================

import { basePrisma } from '@/lib/prisma'
import type { NoteText } from '@/lib/clinical-index/types'

export interface RxCodeEntry {
  code: string
  nameEn: string
  nameCn: string | null
  active: boolean
}

/** note 文本 → 純文字（STANDARD 四欄 + TEMPLATE blocks 合併，空格分隔）。 */
export function noteTextToPlain(note: NoteText | null | undefined): string {
  if (!note) return ''
  if (note.kind === 'STANDARD') {
    return [note.complaints, note.findings, note.diagnosis, note.actions].filter(Boolean).join(' ')
  }
  return note.blocks.map((b) => b.text).filter(Boolean).join(' ')
}

/**
 * 抽取藥物 codes（決定性）：
 * - nameEn 匹配：word-boundary case-insensitive（AMOXICILLIN / amoxicillin 都中）。
 * - nameCn 匹配：直接子串（中文無 word boundary 概念）。
 * - 回傳按字典順序去重 code 陣列。
 */
export function extractRxCodes(note: NoteText | null | undefined, rx: RxCodeEntry[]): string[] {
  if (!note || !rx.length) return []
  const plain = noteTextToPlain(note)
  if (!plain) return []
  const lower = plain.toLowerCase()
  const out: string[] = []
  for (const r of rx) {
    if (!r.active) continue
    let hit = false
    if (r.nameEn) {
      const re = new RegExp(`(^|[^a-z0-9])${escapeRe(r.nameEn.toLowerCase())}($|[^a-z0-9])`, 'i')
      hit = re.test(lower)
    }
    if (!hit && r.nameCn && r.nameCn.trim()) {
      hit = plain.includes(r.nameCn.trim())
    }
    if (hit) out.push(r.code)
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── 字典載入（in-process 5 分鐘 cache — 夜跑/刷新短命 process 夠用；
//    術語表「即時生效」口徑係 quote-parser 層（W admin 頁改完下次 scan 即計），
//    pipeline 層 5 分鐘 cache 唔影響口徑）──────────────────────────────
let rxCache: { at: number; rows: RxCodeEntry[] } | null = null
const RX_TTL_MS = 5 * 60 * 1000

export async function loadRxCodeEntries(force = false): Promise<RxCodeEntry[]> {
  if (!force && rxCache && Date.now() - rxCache.at < RX_TTL_MS) return rxCache.rows
  const rows = await basePrisma.clinicalRxCode.findMany({ where: { active: true } })
  rxCache = { at: Date.now(), rows: rows.map((r) => ({ code: r.code, nameEn: r.nameEn, nameCn: r.nameCn, active: r.active })) }
  return rxCache.rows
}

/** 測試用：清 rx cache */
export function resetRxCodeCache(): void {
  rxCache = null
}

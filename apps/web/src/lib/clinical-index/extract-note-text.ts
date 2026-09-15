// ============================================================
// extractNoteText — 診症記錄兩種樣板解析（cwi-followup-p1-20260915）
//
// 🔴 MD §0.3「讀取邏輯（唯一寫法）」逐字實現。兩種樣板混用（CS Dental
// 自訂樣板佔實測 5 個樣本 4 個）：
//   A. 標準樣板 — 四平欄 complaints/findings/diagnosis/actions
//   B. 自訂樣板 — storedTemplate.sections[].questions[]（type=2 有文本）
//
// 🔴 關鍵陷阱（MD §0.3）：`latestTemplate` 嘅 answer.text 永遠空（佢係樣板
//    定義唔係填寫內容）。**永遠只讀 `storedTemplate`** —— 本函數唔會触碰
//    latestTemplate（unit 有負測兜底）。
// ============================================================

import type { NoteText, NoteTemplateBlock } from './types'

/** Apricot consultation-notes 行（只列本函數用到嘅欄）。 */
export interface ApricotNoteShape {
  id?: string | null
  complaints?: string | null
  findings?: string | null
  diagnosis?: string | null
  actions?: string | null
  /** 填寫內容 — 唯一可信來源。 */
  storedTemplate?: {
    des?: string | null
    sections?: Array<{ questions?: Array<{ question?: string | null; type?: number; answer?: { text?: string | null } | null }> | null }> | null
  } | null
  /** 🔴 樣板定義（answer.text 永遠空）— 本函數刻意唔讀。 */
  latestTemplate?: unknown
  [k: string]: unknown
}

export function extractNoteText(note: ApricotNoteShape): NoteText {
  const flat = ['complaints', 'findings', 'diagnosis', 'actions'] as const;
  if (flat.some((f) => f in note)) {
    return { kind: 'STANDARD', complaints: note.complaints ?? '', findings: note.findings ?? '',
             diagnosis: note.diagnosis ?? '', actions: note.actions ?? '' };
  }
  const qs = note.storedTemplate?.sections?.flatMap((s) => s.questions ?? []) ?? [];
  const tx: NoteTemplateBlock[] = qs.filter((q) => q.type === 2 && q.answer?.text?.trim())
               .map((q) => ({ label: q.question ?? '', text: (q.answer?.text ?? '').trim() }));
  return { kind: 'TEMPLATE', templateName: note.storedTemplate?.des ?? null, blocks: tx };
}

/**
 * 列表 API 用（MD §2.4）：取第一行非空文本，≤60 字。
 * STANDARD：complaints → findings → diagnosis → actions 第一個非空；
 * TEMPLATE：第一個 block。
 */
export function firstLineOf(note: NoteText | null | undefined): string | null {
  if (!note) return null
  const candidates =
    note.kind === 'STANDARD'
      ? [note.complaints, note.findings, note.diagnosis, note.actions]
      : note.blocks.map((b) => b.text)
  // 取第一個「trim 後非空」嘅欄（' ' 唔算有內容）
  const raw = candidates.find((s) => typeof s === 'string' && s.trim().length > 0) ?? ''
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0) ?? ''
  return line.length > 60 ? line.slice(0, 60) : line
}

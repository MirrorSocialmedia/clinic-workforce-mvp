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

import type { NoteText, NoteTemplateBlock, NoteRxLine } from './types'

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
  /** 處方（cwi-walkin-20261018） */
  prescriptions?: unknown
  [k: string]: unknown
}

export function extractNoteText(note: ApricotNoteShape): NoteText {
  const rx = extractRxLines(note.prescriptions)
  const withRx = <T extends object>(t: T): T & { rx?: NoteRxLine[] } => (rx.length ? { ...t, rx } : t)
  const flat = ['complaints', 'findings', 'diagnosis', 'actions'] as const;
  if (flat.some((f) => f in note)) {
    return withRx({ kind: 'STANDARD' as const, complaints: note.complaints ?? '', findings: note.findings ?? '',
             diagnosis: note.diagnosis ?? '', actions: note.actions ?? '' });
  }
  const qs = note.storedTemplate?.sections?.flatMap((s) => s.questions ?? []) ?? [];
  const tx: NoteTemplateBlock[] = qs.filter((q) => q.type === 2 && q.answer?.text?.trim())
               .map((q) => ({ label: q.question ?? '', text: (q.answer?.text ?? '').trim() }));
  return withRx({ kind: 'TEMPLATE' as const, templateName: note.storedTemplate?.des ?? null, blocks: tx });
}

const str = (v: unknown): string => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return ''
  return v.trim()
}
/** 物件或字串 → 顯示字（Apricot 字典欄多數係 { des, code } 物件）。 */
const label = (v: unknown): string =>
  v && typeof v === 'object' ? str((v as any).des ?? (v as any).name ?? (v as any).code) : str(v)

/**
 * ★ cwi-walkin-20261018：處方（note.prescriptions[]）→ 藥名 + 用法摘要。
 * ⚠️ 未有真實「有處方」樣本 — 欄位名按 Apricot 慣例（drug{des}／qty／unit／freq／duration／remarks）
 *   盡量多試；認唔到藥名嘅行跳過。拎到樣本後收窄。
 */
export function extractRxLines(prescriptions: unknown): NoteRxLine[] {
  if (!Array.isArray(prescriptions)) return []
  const out: NoteRxLine[] = []
  for (const p of prescriptions) {
    if (!p || typeof p !== 'object') continue
    const it = p as Record<string, unknown>
    const name =
      label(it.drug) || label(it.medicine) || label(it.item) ||
      str(it.drugName) || str(it.drugDes) || str(it.itemDes) || str(it.des) || str(it.name)
    if (!name) continue
    const qty = str(it.qty ?? it.quantity)
    const unit = label(it.unit ?? it.qtyUnit)
    const parts = [
      label(it.dosage ?? it.dose),
      label(it.frequency ?? it.freq),
      label(it.route),
      str(it.duration ?? it.days) ? `${str(it.duration ?? it.days)}${label(it.durationUnit) || ''}` : '',
      qty ? `共 ${qty}${unit ? ` ${unit}` : ''}` : '',
      str(it.remarks ?? it.remark ?? it.instruction ?? it.instructions),
    ].filter(Boolean)
    out.push({ name, detail: parts.join(' · ') })
  }
  return out
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

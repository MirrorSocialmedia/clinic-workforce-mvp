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
/** Apricot 字典物件（{ des, i18n.des['zh-tw'] }）→ 中文優先顯示字；字串原樣。 */
const label = (v: unknown): string => {
  if (!v || typeof v !== 'object') return str(v)
  const o = v as { des?: unknown; name?: unknown; i18n?: { des?: Record<string, unknown> } }
  return str(o.i18n?.des?.['zh-tw']) || str(o.des) || str(o.name)
}
const labels = (v: unknown): string[] => (Array.isArray(v) ? v.map(label).filter(Boolean) : [])
const DURATION_UNIT: Record<string, string> = { day: '日', week: '星期', month: '個月' }

/**
 * ★ cwi-walkin-20261018：處方（note.prescriptions[]）→ 每隻藥一行。
 * 實測結構（擁有人 2026-10-18 提供 consultation-notes/{id} 樣本）：
 *   drug.des = 藥名；rxDetails[] = { drugDosage, drugFreq, duration, durationUnit, ttlDosage, salesUnit, isPrn, remarks }；
 *   drugInstrs[]（服法，例如「飯後」）；drugCautions[]（注意，例如「抗生素必須服完整個療程」）；字典物件中文優先。
 * 零病人資料（只藥名／用法）。
 */
export function extractRxLines(prescriptions: unknown): NoteRxLine[] {
  if (!Array.isArray(prescriptions)) return []
  const out: NoteRxLine[] = []
  for (const p of prescriptions) {
    if (!p || typeof p !== 'object') continue
    const it = p as Record<string, any>
    const name = label(it.drug) || str(it.drug?.drugLabel)
    if (!name) continue
    const parts: string[] = []
    for (const d of Array.isArray(it.rxDetails) ? it.rxDetails : []) {
      if (!d || typeof d !== 'object') continue
      const unit = label(d.salesUnit)
      const dur = str(d.duration)
      parts.push(
        ...[
          label(d.drugDosage),
          label(d.drugFreq),
          dur ? `${dur}${DURATION_UNIT[str(d.durationUnit)] ?? str(d.durationUnit)}` : '',
          str(d.ttlDosage) ? `共 ${str(d.ttlDosage)}${unit ? ` ${unit}` : ''}` : '',
          d.isPrn === true ? '有需要時服' : '',
          str(d.remarks),
        ].filter(Boolean),
      )
    }
    const instr = labels(it.drugInstrs)
    if (instr.length) parts.push(instr.join('、'))
    if (str(it.remarks)) parts.push(str(it.remarks))
    const cautions = labels(it.drugCautions)
    out.push({ name, detail: parts.join(' · '), ...(cautions.length ? { caution: cautions.join('；') } : {}) })
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

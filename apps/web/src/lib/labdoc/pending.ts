/**
 * cwm-labdoc P2 CHUNK 5 — §9 待處理（7 類別）純 helper
 *
 * 全部純函數：冇 DB、冇 side effect — route 層負責撈數據再傳入。
 * 類別定義（§9；P2 範圍 7 類 — STATEMENT_DIFF／MISSING_IN_SYSTEM／NOT_ON_STATEMENT 屬 P3）：
 *
 * | category           | 權限（睇到）              | 動作 |
 * |--------------------|---------------------------|------|
 * | UNMATCHED_LINE     | lab_invoice               | 去對數頁 |
 * | NOT_RECEIVED       | lab_invoice               | 確認到貨（§7.7） |
 * | RECEIVED_NO_INVOICE| lab_invoice               | 上傳 invoice |
 * | LOCKED_ADJUST      | lab_invoice／provider_payout | 去下期調整 |
 * | AMOUNT_REVIEW      | lab_statement             | 對相覆核 →「已覆核」（API resolve） |
 * | NEW_PAYEE          | lab_statement             | 記住（API resolve：upsert PAYEE alias） |
 * | EXTRACT_FAILED     | lab_invoice               | 再讀（retry） |
 *
 * 全部係查詢（唔建表）；每類有數字 badge。
 * 測試：pending.test.ts（csvGuard 等）。
 */

// ------------------------------------------------------------------
// 類別定義
// ------------------------------------------------------------------

export type PendingCategory =
  | 'UNMATCHED_LINE'
  | 'NOT_RECEIVED'
  | 'RECEIVED_NO_INVOICE'
  | 'LOCKED_ADJUST'
  | 'AMOUNT_REVIEW'
  | 'NEW_PAYEE'
  | 'EXTRACT_FAILED'
  | 'STATEMENT_DIFF'
  | 'MISSING_IN_SYSTEM'
  | 'NOT_ON_STATEMENT'

/** 持有其中一個權限就見到呢類（OWNER 有全部權限 — 由 perms 計算自然覆蓋）。 */
export const PENDING_CATEGORY_PERMS: Record<PendingCategory, string[]> = {
  UNMATCHED_LINE: ['lab_invoice'],
  NOT_RECEIVED: ['lab_invoice'],
  RECEIVED_NO_INVOICE: ['lab_invoice'],
  // §9：provider_payout 處理；lab_invoice 睇到
  LOCKED_ADJUST: ['lab_invoice', 'provider_payout'],
  AMOUNT_REVIEW: ['lab_statement'],
  NEW_PAYEE: ['lab_statement'],
  EXTRACT_FAILED: ['lab_invoice'],
  // ★ P3 §9 三類
  STATEMENT_DIFF: ['lab_statement'],
  MISSING_IN_SYSTEM: ['lab_invoice'],
  NOT_ON_STATEMENT: ['lab_statement'],
}

export const PENDING_CATEGORIES: PendingCategory[] = [
  'UNMATCHED_LINE',
  'NOT_RECEIVED',
  'RECEIVED_NO_INVOICE',
  'LOCKED_ADJUST',
  'AMOUNT_REVIEW',
  'NEW_PAYEE',
  'EXTRACT_FAILED',
  'STATEMENT_DIFF',
  'MISSING_IN_SYSTEM',
  'NOT_ON_STATEMENT',
]

export const PENDING_CATEGORY_LABELS: Record<PendingCategory, string> = {
  UNMATCHED_LINE: '未對數行',
  NOT_RECEIVED: '已連單未到貨',
  RECEIVED_NO_INVOICE: '已到貨未上單',
  LOCKED_ADJUST: '已鎖待調整',
  AMOUNT_REVIEW: '人手改數待覆核',
  NEW_PAYEE: '新收款人',
  EXTRACT_FAILED: '讀單失敗',
  STATEMENT_DIFF: '月結單差異未處理',
  MISSING_IN_SYSTEM: '系統未有單',
  NOT_ON_STATEMENT: '月結單未有',
}

/** 單一 item 形狀（所有類別共用 — UI／CSV 簡單）。 */
export interface PendingItem {
  id: string // lineId（UNMATCHED_LINE）或 docId／costCaseId
  refType: 'LINE' | 'DOC' | 'COST'
  docId: string | null // LINE item 帶 docId 方便跳轉
  /** 月結單類（STATEMENT_DIFF／MISSING_IN_SYSTEM）：分段 id — 直接跳分段頁 */
  sectionId?: string | null
  labName: string | null
  clinicId: string | null
  providerId: string | null
  docNo: string | null
  date: string | null // YYYY-MM-DD
  amount: number | null
  patientCode: string | null
  /** 日齡（UNMATCHED_LINE：doc 靜置日數；RECEIVED_NO_INVOICE：到貨後日數） */
  days: number | null
  /** 類別補充（extractError／payeeRaw／linkedSum 等 — 文字） */
  extra: string | null
  /** 僅 DOC 類（AMOUNT_REVIEW／NEW_PAYEE）：LabDocument.version — resolve optimistic lock 用 */
  version?: number | null
}

/** 回傳該使用者可以見到嘅類別（按 perms；未列入 PENDING_CATEGORIES 嘅 key 忽略）。 */
export function visibleCategories(perms: string[]): PendingCategory[] {
  const set = new Set(perms)
  return PENDING_CATEGORIES.filter((c) => PENDING_CATEGORY_PERMS[c].some((p) => set.has(p)))
}

/** 'YYYY-MM' → [月初, 下月初)；格式錯 → null。 */
export function monthRange(month: string): { gte: Date; lt: Date } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  const gte = new Date(Date.UTC(y, mo - 1, 1))
  const lt = new Date(Date.UTC(y, mo, 1))
  return { gte, lt }
}

// ------------------------------------------------------------------
// ★ P3：NOT_ON_STATEMENT（§8.2 反向）— M 同 M+1 都確認咗仍然冇
// ------------------------------------------------------------------

/** resultJson.notOnStatement 元素（CHUNK 3 快照形狀）。 */
export interface NotOnStatementEntry {
  docId: string
  docNo: string | null
  docDate: string | null
  total: number | null
  clinicId: string | null
  providerId: string | null
  labId: string | null
  labName: string | null
}

/** 'YYYY-MM' → 下月 'YYYY-MM'；格式錯 → null。 */
export function nextMonthStr(month: string): string | null {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}

export interface NotOnStatementFilter {
  month?: string
  labId?: string
  clinicId?: string
  providerId?: string
  /** 診所 scope（收窄時）— null/undefined = 全集團 */
  scope?: string[] | null
}

/**
 * M ∩ M+1（按 docId）：系統 invoice 喺 M 月同 M+1 月兩份已確認月結單嘅反向清單都出現
 * → 真係月結單冇（「睇單、同 Lab 跟進」）。純函數 — byMonth 由 route 從 RECONCILED
 * 文件 CONFIRMED 分段嘅 resultJson.notOnStatement 撈。
 */
export function intersectNotOnStatement(
  byMonth: Map<string, NotOnStatementEntry[]>,
  f: NotOnStatementFilter = {},
): PendingItem[] {
  const items: PendingItem[] = []
  for (const [m, arr] of byMonth) {
    if (f.month && m !== f.month) continue
    const next = nextMonthStr(m)
    if (!next) continue
    const nextArr = byMonth.get(next)
    if (!nextArr) continue
    const nextIds = new Set(nextArr.map((x) => x.docId))
    const seen = new Set<string>()
    for (const e of arr) {
      if (!e.docId || seen.has(e.docId) || !nextIds.has(e.docId)) continue
      if (f.labId && e.labId !== f.labId) continue
      if (f.clinicId && e.clinicId !== f.clinicId) continue
      if (f.providerId && e.providerId !== f.providerId) continue
      if (f.scope && (!e.clinicId || !f.scope.includes(e.clinicId))) continue
      seen.add(e.docId)
      items.push({
        id: e.docId,
        refType: 'DOC',
        docId: e.docId,
        labName: e.labName,
        clinicId: e.clinicId,
        providerId: e.providerId,
        docNo: e.docNo,
        date: e.docDate,
        amount: e.total,
        patientCode: null,
        days: null,
        extra: `${m} 同 ${next} 兩份月結單都確認咗，仍然冇`,
      })
    }
  }
  return items.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
}

// ------------------------------------------------------------------
// CSV 公式注入守門（§9：所有文字欄位開頭 = + - @ → 前面加 '）
// ------------------------------------------------------------------

/**
 * CSV 文字欄位守門：
 * 1. 開頭 `= + - @`（以及 tab／CR — Excel 一樣會執行）→ 前加 `'`
 * 2. 含 `" ` ` , ` `\n` `\r` → 用 `"` 包埋，內部 `"` 雙寫
 * 純函數 — 測試直接打。
 */
export function csvGuardCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/^[=+\-@\t\r]/.test(s)) return `'${s}`
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** 一列 → CSV 行（全部經 csvGuardCell）。 */
export function csvRow(values: unknown[]): string {
  return values.map(csvGuardCell).join(',')
}

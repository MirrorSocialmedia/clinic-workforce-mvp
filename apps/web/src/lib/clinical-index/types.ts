// ============================================================
// 索引管道 — 類型與常量（cwi-followup-p1-20260915）
//
// MD: wa-clinic-inbox-followup-v2 §2（P1 索引管道）
// 鐵律（§6）：
//   - 限速 400ms/call（CLINICAL_INDEX_RATE_MS 只係 dev/e2e 提速口，生產唔設 = 400）
//   - 爽約明確 bookingStatus = -3（唔照抄 treatment-summary 嘅 >= 0）
//   - latestTemplate 永遠唔用（見 extract-note-text.ts）
// ============================================================

/** Apricot call 可注入點（預設 = 真 apricotCall；e2e/dev stub 傳決定性 mock）。 */
export type ClinicalCallFn = (path: string, init?: { body?: string }) => Promise<any>

/** 標準樣板（MD §0.3 A — 四平欄）。
 * 🔴 用 type 別名唔係 interface — Prisma InputJsonValue 要求 index signature（interface 冇）。 */
export type NoteStandard = {
  kind: 'STANDARD'
  complaints: string
  findings: string
  diagnosis: string
  actions: string
}

/** 自訂樣板一欄（label = question，text = answer.text trim）。 */
export type NoteTemplateBlock = {
  label: string
  text: string
}

/** 自訂樣板（MD §0.3 B — 只讀 storedTemplate）。 */
export type NoteTemplate = {
  kind: 'TEMPLATE'
  templateName: string | null
  blocks: NoteTemplateBlock[]
}

export type NoteText = NoteStandard | NoteTemplate

/** upsertVisitIndex 入參（夜跑／回填／手動刷新三條路徑共用）。 */
export interface ResolvedVisit {
  clinicId: string
  patientApricotId: string
  patientCode: string | null
  phoneHashes: string[]
  /** YYYY-MM-DD（HK 日界） */
  visitDate: string
  apricotApptId: string | null
  apricotNoteId: string | null
  bookingStatus: number
  visitReasonCodes: string[]
  providerCode: string | null
  hasNote: boolean
  noteKind: string | null
  noteJson: NoteText | null
  /** 藥物 code（cwi-followup-p4 S4 — extractRxCodes 由 note 抽；C 類抗生素判定） */
  rxCodes: string[]
  billTtlAmt: number | null
  billOsAmt: number | null
}

/** MD §0.1：clinic-patients/search 固定 page size 50（size 參數無效）。 */
export const PAGE_SIZE = 50
/** MD §2.3：重掃過去 7 日 hasNote=false 行（醫生可能補寫）。 */
export const RESCAN_DAYS = 7
/** MD §2.3：夜跑連帶索引未來 7 日預約（供 B 類）。 */
export const FUTURE_WINDOW_DAYS = 7
/** MD §2.5：回填 maxCalls 護欄 default。 */
export const BACKFILL_MAX_CALLS = 30_000
/** MD §2.5：回填 maxHours 護欄 default。 */
export const BACKFILL_MAX_HOURS = 4
/** MD §2.5：回填每晚配額 ≈90 日（365 日 / 4 晚）。 */
export const BACKFILL_DAYS_PER_RUN = 90
/** MD §2.5：回填範圍 365 日。 */
export const BACKFILL_RANGE_DAYS = 365

/**
 * 限速（ms/call）— 鐵律 400ms（MD §6.7）。
 * CLINICAL_INDEX_RATE_MS 只係 dev/e2e 提速口（e2e 設 5）；生產 deploy 唔設 = 400。
 */
export function rateLimitMs(): number {
  const v = Number(process.env.CLINICAL_INDEX_RATE_MS)
  return Number.isFinite(v) && v >= 0 ? v : 400
}

/** 鐵律 7：爽約明確 -3（MD §0.2 實測；唔係 treatment-summary 嘅 >= 0 口徑）。 */
export const BOOKING_STATUS_NO_SHOW = -3
/** 有效預約（到診／完成／改期）— B/C/D/E 觸發用。 */
export const BOOKING_STATUS_EFFECTIVE = [0, 1, 4, 102]

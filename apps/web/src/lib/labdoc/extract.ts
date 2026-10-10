/**
 * cwm-labdoc P2 — §5.1 背景工作（讀單 runner + sweep）
 *
 * 流程（§5.1）：
 *  上傳 API 建完單據即回應；同一 request 尾 `void runLabDocExtract(docId)`（同 apricot/sync 做法）。
 *  runLabDocExtract：
 *   1. 條件更新 status: UPLOADED|EXTRACT_FAILED → EXTRACTING（updateMany，0 行就退出 — 防兩個 worker 同時做）
 *   2. 每 20 秒刷 heartbeatAt（sweep 靠佢判斷 process 死咗）
 *   3. 揀模式：全部頁 hasTextLayer → TEXT；否則 VISION
 *   4. 叫 proxy（§5.2 llm-client）；失敗按 NullReason 記 extractError、extractAttempts++；
 *      < 3 就 30 秒後再試；= 3 → EXTRACT_FAILED
 *   5. 成功 → zod 驗證 → 敏感數字過濾（§5.6）→ 寫 extractedJson（過濾後）
 *      → 正規化寫欄位同行 → 系統檢查（§5.5）→ 識別（§6）→ NEEDS_REVIEW
 *   6. 寫 docNo 撞 partial unique index（P2002）→ DUPLICATE + duplicateOfId
 *
 * Sweep（cron 每 5 分鐘，POST /api/internal/labdoc-sweep）：
 *   EXTRACTING AND heartbeatAt < now-5min → 當失敗（attempts++；=3 EXTRACT_FAILED，<3 回 UPLOADED 再讀）
 *   UPLOADED AND createdAt < now-2min → 再觸發
 *   **EXTRACT_FAILED 唔會自動再試**（T17）— 要人手 POST /:id/retry（重置 attempts）
 *
 * 🔴 零原文：log 只記 docId + reason + 計數；單據內容／頁文字／images 永不入 log。
 *
 * 測試 hook：__drainLabDocExtractions()（等晒在途 run 完成 — route test 用）。
 */
import { prisma } from '../prisma'
import { extractLabDocViaWaInbox, type LabDocExtractRequest, type LabDocKind } from './llm-client'
import { labDocResultSchema, type LabDocResult } from './schema'
import { filterSensitiveNumbers } from './sensitive-filter'
import { checkExtracted } from './validate-extract'
import { identifyDocument, identifyStatementSection, latestStatementLineMonth } from './identify'
import {
  createStatementSections,
  findStatementSectionDuplicate,
  resolveStatementMonth,
  sectionDuplicateIssue,
} from './statement-sections'
import { autoReconcileIfReady } from './statement-reconcile'
import { buildPageKey, readEncrypted } from './storage'
import { normPatientCode } from '../cost-entry/patient-code'
import { loadPdfjs } from './pdfjs'

/** §5.1：三次失敗先 EXTRACT_FAILED */
export const LABDOC_MAX_ATTEMPTS = 3
/** §5.1：失敗後 30 秒再試 */
export const LABDOC_RETRY_MS = 30_000
/** §5.1：每 20 秒刷 heartbeatAt */
export const LABDOC_HEARTBEAT_MS = 20_000
/** §5.1 sweep：EXTRACTING heartbeat 冷卻 5 分鐘當 process 死 */
export const SWEEP_STALE_MS = 5 * 60_000
/** §5.1 sweep：UPLOADED 超過 2 分鐘未開工 → 再觸發 */
export const SWEEP_UPLOAD_MS = 2 * 60_000
/** §5.2：TEXT 单次 60,000 字上限（W 側同款 cap） */
const MAX_TEXT_CHARS = 60_000
/** §5.2：VISION 每 call 最多 8 張圖（W 側同款 cap） */
const MAX_IMAGES_PER_CALL = 8
/** §5.2：STATEMENT TEXT 太長（> 40 行）→ 逐頁分開叫再合併 sections */
const STATEMENT_MAX_LINES = 40

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------
// 在途 run 追蹤（測試 drain 用）
// ------------------------------------------------------------------
const inflight = new Set<Promise<unknown>>()

/** 等晒在途 extraction（route test 用；生產唔會叫）。 */
export function __drainLabDocExtractions(): Promise<void> {
  return new Promise<void>((resolve) => {
    const tick = (): void => {
      if (inflight.size === 0) resolve()
      else setTimeout(tick, 10)
    }
    tick()
  })
}

function track(p: Promise<unknown>): void {
  const wrapped = p.finally(() => inflight.delete(wrapped))
  inflight.add(wrapped)
}

// ------------------------------------------------------------------
// 頁資料（TEXT 要重新抽文字層 — P1 pagesJson 只存 textChars，唔存文字）
// ------------------------------------------------------------------
interface PageRef {
  fileId: string
  /** 顯示圖 key（VISION 用；P1 已渲染成長邊 ≤1600 q85，遠低於 W 5MB 上限） */
  displayKey: string
  pageNo: number
  /** TEXT 用；null = 冇文字層／抽取失敗 */
  text: string | null
  hasTextLayer: boolean
  mime: string
}

async function extractPdfPageTexts(pdfBuf: Buffer): Promise<string[]> {
  const pdfjs = await loadPdfjs()
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(pdfBuf), useSystemFonts: true })
  const doc = await loadingTask.promise
  try {
    const texts: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      let t = ''
      try {
        const tc = await page.getTextContent()
        t = tc.items.map((it: any) => String(it.str ?? '')).join('')
      } catch {
        t = ''
      }
      texts.push(t.trim())
    }
    return texts
  } finally {
    // pdfjs-dist 6.x：DocumentProxy 已無 destroy — 用 loadingTask.destroy()
    ;(loadingTask as unknown as { destroy: () => Promise<unknown> }).destroy().catch(() => undefined)
  }
}

/** 由 doc（含 pages+file）組 PageRef[]；TEXT 時解密密碟上原檔重新抽逐頁文字。 */
async function buildPages(doc: any): Promise<PageRef[]> {
  const pageRows: any[] = [...(doc.pages ?? [])].sort((a: any, b: any) => a.sortOrder - b.sortOrder)
  const fileIds = [...new Set(pageRows.map((p) => p.fileId))]
  const files = fileIds.length
    ? await prisma.labFile.findMany({ where: { id: { in: fileIds } } })
    : []
  const byId = new Map<string, any>(files.map((f) => [f.id, f]))

  const textCache = new Map<string, string[] | null>()
  const out: PageRef[] = []
  for (const p of pageRows) {
    const f = byId.get(p.fileId)
    if (!f) continue
    let text: string | null = null
    if (f.hasTextLayer && f.mime === 'application/pdf') {
      let texts = textCache.get(f.id)
      if (texts === undefined) {
        try {
          const buf = await readEncrypted(f.storageKey)
          texts = await extractPdfPageTexts(buf)
        } catch (e) {
          // 文字層抽唔到 → 呢個 file 當 VISION（display 圖照有）
          console.warn('[labdoc/extract] text layer extract failed', { fileId: f.id, err: String((e as Error)?.message ?? e) })
          texts = null
        }
        textCache.set(f.id, texts)
      }
      text = texts ? (texts[p.pageNo - 1] ?? null) : null
    }
    out.push({
      fileId: f.id,
      displayKey: buildPageKey(f.id, f.uploadedAt, p.pageNo, 'display'),
      pageNo: p.pageNo,
      text,
      hasTextLayer: f.hasTextLayer === true,
      mime: f.mime,
    })
  }
  return out
}

// ------------------------------------------------------------------
// 呼叫計劃（§5.2：TEXT 合併／逐頁；VISION invoice 一次一頁、statement 分批 ≤8）
// ------------------------------------------------------------------
interface ExtractCall {
  text: string | null
  images: string[] | null
  pageNos: number[]
}

/** §5.2：頁之間用 '\n<<<PAGE n>>>\n'（n = 後一頁嘅頁碼） */
function joinPageTexts(pages: PageRef[]): string {
  if (pages.length === 1) return pages[0].text ?? ''
  let s = pages[0].text ?? ''
  for (let i = 1; i < pages.length; i++) {
    s += `\n<<<PAGE ${pages[i].pageNo}>>>\n` + (pages[i].text ?? '')
  }
  return s
}

async function loadVisionImages(pages: PageRef[]): Promise<Map<number, string>> {
  // VISION：解密密每頁顯示圖（長邊 1600；W 上限 5MB/張，P1 渲染規格下遠低於上限）
  const images = new Map<number, string>()
  for (const p of pages) {
    const buf = await readEncrypted(p.displayKey)
    images.set(p.pageNo, buf.toString('base64'))
  }
  return images
}

function perPageCalls(pages: PageRef[], mode: 'TEXT' | 'VISION', images: Map<number, string>): ExtractCall[] {
  if (mode === 'TEXT') {
    return pages.map((p) => ({ text: p.text ?? '', images: null, pageNos: [p.pageNo] }))
  }
  return pages.map((p) => ({ text: null, images: [images.get(p.pageNo) ?? ''], pageNos: [p.pageNo] }))
}

async function replanPerPage(pages: PageRef[], mode: 'TEXT' | 'VISION'): Promise<ExtractCall[]> {
  if (mode === 'VISION') return perPageCalls(pages, 'VISION', await loadVisionImages(pages))
  return perPageCalls(pages, 'TEXT', new Map())
}

/** 組第一次計劃（§5.2）。 */
async function planCalls(pages: PageRef[], mode: 'TEXT' | 'VISION', kind: 'INVOICE' | 'STATEMENT'): Promise<ExtractCall[]> {
  if (mode === 'TEXT') {
    const combined = joinPageTexts(pages)
    const lineCount = combined.split('\n').filter((l) => l.trim() !== '').length
    const fitsSingle = combined.length <= MAX_TEXT_CHARS && (kind !== 'STATEMENT' || lineCount <= STATEMENT_MAX_LINES)
    if (fitsSingle) return [{ text: combined, images: null, pageNos: pages.map((p) => p.pageNo) }]
    return perPageCalls(pages, 'TEXT', new Map())
  }
  const images = await loadVisionImages(pages)
  if (kind === 'INVOICE') {
    // §5.2：invoice 一次一頁（1 張圖）
    return perPageCalls(pages, 'VISION', images)
  }
  const calls: ExtractCall[] = []
  for (let i = 0; i < pages.length; i += MAX_IMAGES_PER_CALL) {
    const batch = pages.slice(i, i + MAX_IMAGES_PER_CALL)
    calls.push({
      text: null,
      images: batch.map((p) => images.get(p.pageNo) ?? ''),
      pageNos: batch.map((p) => p.pageNo),
    })
  }
  return calls
}

// ------------------------------------------------------------------
// 多次呼叫合併（逐頁／逐段 call → 一份 §5.4 結果）
// ------------------------------------------------------------------
/**
 * 合併語義（決定 log 2026-10-05 gen2）：
 *  頭部欄 = 第一頁有值（單號／日期／Lab 名通常喺首頁）；
 *  subtotal/total = 最後一頁有值（總數通常喺最後頁）；
 *  groups/sections 順序 concat；readIssues 並集。
 */
function mergeResults(parts: LabDocResult[]): LabDocResult {
  const firstNonNull = <T>(getter: (p: LabDocResult) => T | null): T | null => {
    for (const p of parts) {
      const v = getter(p)
      if (v !== null && v !== undefined) return v
    }
    return null
  }
  const lastNonNull = <T>(getter: (p: LabDocResult) => T | null): T | null => {
    for (let i = parts.length - 1; i >= 0; i--) {
      const v = getter(parts[i])
      if (v !== null && v !== undefined) return v
    }
    return null
  }
  return {
    kind: parts[0].kind,
    lab: {
      nameRaw: firstNonNull((p) => p.lab.nameRaw),
      nameCnRaw: firstNonNull((p) => p.lab.nameCnRaw),
      payeeRaw: firstNonNull((p) => p.lab.payeeRaw),
    },
    billTo: {
      nameRaw: firstNonNull((p) => p.billTo.nameRaw),
      addressRaw: firstNonNull((p) => p.billTo.addressRaw),
      customerNoRaw: firstNonNull((p) => p.billTo.customerNoRaw),
      shortCodeRaw: firstNonNull((p) => p.billTo.shortCodeRaw),
      doctorRaw: firstNonNull((p) => p.billTo.doctorRaw),
    },
    docNoRaw: firstNonNull((p) => p.docNoRaw),
    docNoLabel: firstNonNull((p) => p.docNoLabel),
    dateRaw: firstNonNull((p) => p.dateRaw),
    date: firstNonNull((p) => p.date),
    deliveryDate: firstNonNull((p) => p.deliveryDate),
    orderReceivedDate: firstNonNull((p) => p.orderReceivedDate),
    statementMonth: firstNonNull((p) => p.statementMonth),
    groups: parts.flatMap((p) => p.groups),
    sections: parts.flatMap((p) => p.sections),
    subtotal: lastNonNull((p) => p.subtotal),
    total: lastNonNull((p) => p.total),
    readIssues: [...new Set(parts.flatMap((p) => p.readIssues))],
  }
}

// ------------------------------------------------------------------
// runner
// ------------------------------------------------------------------
export interface RunOpts {
  /** §5.1 失敗後重試間隔（預設 30 秒；測試調低） */
  retryDelayMs?: number
  /** heartbeat 間隔（預設 20 秒；測試調低） */
  heartbeatMs?: number
  maxAttempts?: number
}

export type ClaimResult = 'claimed' | 'skipped'

/**
 * §5.1 入口：條件 claim（UPLOADED|EXTRACT_FAILED → EXTRACTING）+ 背景執行。
 * 回 'claimed'／'skipped'（0 行 = 有其他 worker 持有／狀態唔啱 — 直接退出）。
 */
export async function runLabDocExtract(docId: string, opts: RunOpts = {}): Promise<ClaimResult> {
  const claimed = await prisma.labDocument.updateMany({
    where: { id: docId, status: { in: ['UPLOADED', 'EXTRACT_FAILED'] } },
    data: { status: 'EXTRACTING', heartbeatAt: new Date(), version: { increment: 1 } },
  })
  if (claimed.count === 0) return 'skipped'
  track(
    runClaimed(docId, opts).catch((e) => {
      console.error('[labdoc/extract] unexpected error', { docId, err: String(e?.message ?? e) })
      // 最後防线：留低 EXTRACTING 嘅話 sweep 5 分鐘後先救 — 直接記失敗
      prisma.labDocument
        .updateMany({ where: { id: docId, status: 'EXTRACTING' }, data: { status: 'EXTRACT_FAILED', extractError: 'unexpected' } })
        .catch(() => undefined)
    }),
  )
  return 'claimed'
}

/** retry route 用：claim 已由 route 做完（EXTRACT_FAILED → EXTRACTING + attempts 重置）。 */
export function runExtractionAfterClaim(docId: string, opts: RunOpts = {}): void {
  track(
    runClaimed(docId, opts).catch((e) => {
      console.error('[labdoc/extract] unexpected error', { docId, err: String(e?.message ?? e) })
      prisma.labDocument
        .updateMany({ where: { id: docId, status: 'EXTRACTING' }, data: { status: 'EXTRACT_FAILED', extractError: 'unexpected', version: { increment: 1 } } })
        .catch(() => undefined)
    }),
  )
}

async function runClaimed(docId: string, opts: RunOpts): Promise<void> {
  const retryDelayMs = opts.retryDelayMs ?? (Number(process.env.LABDOC_RETRY_MS_MS) > 0 ? Number(process.env.LABDOC_RETRY_MS_MS) : LABDOC_RETRY_MS)
  const maxAttempts = opts.maxAttempts ?? LABDOC_MAX_ATTEMPTS

  const doc = await prisma.labDocument.findUnique({
    where: { id: docId },
    include: { pages: { include: { file: true }, orderBy: { sortOrder: 'asc' } } },
  })
  if (!doc) return
  const kind = doc.kind as LabDocKind

  // §5.1.2：每 20 秒刷 heartbeatAt（sweep 靠佢判斷 process 死咗先當失敗）
  const hb = setInterval(() => {
    prisma.labDocument.update({ where: { id: docId }, data: { heartbeatAt: new Date() } }).catch(() => undefined)
  }, opts.heartbeatMs ?? LABDOC_HEARTBEAT_MS)
  if (typeof hb.unref === 'function') hb.unref()

  try {
    const pages = await buildPages(doc)
    if (pages.length === 0) {
      await failFinal(docId, 'no_pages')
      return
    }
    // §5.1.3：全部頁 hasTextLayer（同文字抽到）→ TEXT；否則 VISION
    const mode: 'TEXT' | 'VISION' =
      pages.every((p) => p.hasTextLayer && p.text !== null) ? 'TEXT' : 'VISION'

    const labProfile = doc.labId
      ? await prisma.labProfile.findUnique({ where: { labId: doc.labId }, select: { extractionHint: true, statementKind: true, defaultDocNoKind: true } })
      : null
    const labHint = labProfile?.extractionHint ?? null

    let plan = await planCalls(pages, mode, kind)

    let noRetry = false
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const parts: LabDocResult[] = []
      let fail: string | null = null
      outer: for (let ci = 0; ci < plan.length; ci++) {
        const call = plan[ci]
        const req: LabDocExtractRequest = {
          mode,
          kindHint: kind,
          labHint,
          text: call.text,
          images: call.images,
        }
        const { outcome, nullReason } = await extractLabDocViaWaInbox(req, { maxAttempts: 3 })
        // nullReason 'llm' = W 側 200 但 result null（附 outcome.reason）→ 交俾下面 outcome.result === null 分支
        //（2026-10-10 修：之前喺度就 break，truncated 分頁重讀永遠行唔到，extractError 只得 'llm'）
        if (nullReason && !(nullReason === 'llm' && outcome)) {
          fail = nullReason
          break
        }
        if (outcome === null) {
          fail = 'upstream'
          break
        }
        if (outcome.result === null) {
          const reason = outcome.reason ?? 'llm_error'
          if (reason === 'truncated' && plan.length === 1 && plan[0].pageNos.length > 1) {
            // §5.2：truncated = 輸出撞 max_tokens → 分頁/分段再叫（唔計一次失敗；已係最細粒度先計）
            // ⚠ for...of 唔會跟 reassign — index loop + ci 重開先有效
            plan = await replanPerPage(pages, mode)
            ci = -1
            continue outer
          }
          fail = `llm:${reason}`
          // 已係最細粒度仲 truncated → 原樣重試冇用（§5.2 reason 表）→ 唔再試
          if (reason === 'truncated') noRetry = true
          break
        }
        const parsed = labDocResultSchema.safeParse(outcome.result)
        if (!parsed.success) {
          // 多餘欄位已丟棄（非 strict）；必填缺/格式錯 = bad_response（重試計一次）
          fail = 'bad_response'
          break
        }
        parts.push(parsed.data)
      }

      if (!fail) {
        await finishSuccess(docId, doc, parts, mode, labProfile)
        return
      }

      // §5.1.4：失敗記 extractError + attempts++
      // updateMany（唔係 update）：doc 喺途被刪（merge/split/手動）→ 0 行靜默，唔係 P2025 轟炸
      // status 條件：讀單途中被作廢／合併（VOID）→ 0 行，唔再郁（2026-10-10 模擬：作廢後讀完會翻生）
      const still = await prisma.labDocument.updateMany({
        where: { id: docId, status: 'EXTRACTING' },
        data: { extractAttempts: { increment: 1 }, extractError: fail.slice(0, 200), version: { increment: 1 } },
      })
      if (still.count === 0) return
      if (noRetry) break
      if (attempt < maxAttempts) await sleep(retryDelayMs)
    }
    // = 3 → EXTRACT_FAILED（sweep 唔會再自動試；人手 retry 先重置 attempts）
    await prisma.labDocument.updateMany({ where: { id: docId, status: 'EXTRACTING' }, data: { status: 'EXTRACT_FAILED', version: { increment: 1 } } })
  } finally {
    clearInterval(hb)
  }
}

async function failFinal(docId: string, reason: string): Promise<void> {
  await prisma.labDocument.updateMany({
    where: { id: docId, status: 'EXTRACTING' },
    data: { status: 'EXTRACT_FAILED', extractError: reason, extractAttempts: { increment: 1 }, version: { increment: 1 } },
  })
}

// ------------------------------------------------------------------
// 成功寫入（§5.1.5 + 6）
// ------------------------------------------------------------------
async function finishSuccess(
  docId: string,
  doc: any,
  parts: LabDocResult[],
  mode: 'TEXT' | 'VISION',
  labProfile: { extractionHint: string | null; statementKind: string | null; defaultDocNoKind: string | null } | null,
): Promise<void> {
  const result = parts.length === 1 ? parts[0] : mergeResults(parts)
  // §5.1.5：敏感數字過濾 → 寫 extractedJson（過濾後）
  const { result: filtered, removedFields } = filterSensitiveNumbers(result, { docId })
  // §5.5 系統檢查（對過濾後嘅結果）
  let checks = checkExtracted(filtered, {
    docKind: doc.kind as LabDocKind,
    uploadedAt: doc.createdAt,
    statementKind: (labProfile?.statementKind ?? null) as 'DETAIL' | 'INVOICE_LIST' | 'OUTSTANDING' | null,
  })
  // §6 識別（CHUNK 1：Lab + 單號；CHUNK 2 補診所/醫生/病人編號）
  const identified = await identifyDocument(prisma, filtered, {
    selfDocId: docId,
    uploadLabId: doc.labId,
    defaultDocNoKind: labProfile?.defaultDocNoKind ?? null,
  })
  // 上傳時未揀 Lab → 讀單前冇 profile；識別到 Lab 之後補攞（2026-10-10 修：之前月結單 statementKind 永遠 null，
  // §5.5 欠款型 currentTotal 檢查同畫面分型都用錯）
  const effProfile =
    labProfile ??
    (identified.labId
      ? await prisma.labProfile.findUnique({ where: { labId: identified.labId }, select: { extractionHint: true, statementKind: true, defaultDocNoKind: true } })
      : null)
  if (!labProfile && effProfile?.statementKind && doc.kind === 'STATEMENT') {
    checks = checkExtracted(filtered, {
      docKind: doc.kind as LabDocKind,
      uploadedAt: doc.createdAt,
      statementKind: effProfile.statementKind as 'DETAIL' | 'INVOICE_LIST' | 'OUTSTANDING',
    })
  }

  const readIssues = unionStrings([...filtered.readIssues, ...checks.readIssues, ...removedFields.map((f) => `SENSITIVE_REMOVED:${f}`)])
  const ymdToDate = (s: string | null): Date | undefined => (s ? new Date(`${s}T00:00:00Z`) : undefined)

  // §6.5：INVOICE 行 patientCode 正規化需要診所 shortName（純數字編號補前綴；§6.5.3）
  const clinicRow = identified.clinicId
    ? await prisma.clinic.findUnique({ where: { id: identified.clinicId }, select: { shortName: true } })
    : null
  const normLinePatientCode = (raw: string | null): string | null =>
    normPatientCode(raw, clinicRow?.shortName ?? null)

  // ★ P3 §8.1：STATEMENT — 逐段識別＋shortName（transaction 前讀操作；結果落 headerData/sections）
  const finalLabId = identified.labId ?? doc.labId
  let sectionIdents: Array<import('./identify').SectionIdentifyResult> = []
  let sectionClinicShortNames: Array<string | null> = []
  let createdSectionIds: string[] = []
  if (filtered.kind === 'STATEMENT') {
    sectionIdents = await Promise.all(
      filtered.sections.map((s) =>
        identifyStatementSection(prisma, filtered, {
          labId: finalLabId,
          section: s,
        }),
      ),
    )
    // 逐段 clinic shortName（patientCode 正規化用）
    const secClinicIds = [...new Set(sectionIdents.map((i) => i.clinicId).filter((v): v is string => !!v))]
    const secClinics = secClinicIds.length
      ? await prisma.clinic.findMany({ where: { id: { in: secClinicIds } }, select: { id: true, shortName: true } })
      : []
    const snById = new Map(secClinics.map((c: any) => [c.id, c.shortName]))
    sectionClinicShortNames = sectionIdents.map((i) => (i.clinicId ? (snById.get(i.clinicId) ?? null) : null))
  }

  const headerData: Record<string, unknown> = {
    status: 'NEEDS_REVIEW',
    version: { increment: 1 }, // §7.1 樂觀鎖：每次寫 +1（讀單寫頭部 = 寫）
    extractedJson: filtered,
    readIssues,
    extractSource: mode,
    extractError: null,
    labId: identified.labId ?? doc.labId,
    labBasis: identified.labBasis,
    labNameRaw: filtered.lab.nameRaw,
    payeeRaw: filtered.lab.payeeRaw,
    payeeIsNew: identified.payeeIsNew,
    clinicId: identified.clinicId,
    clinicBasis: identified.clinicBasis,
    clinicEvidence: identified.clinicEvidence,
    providerId: identified.providerId,
    providerBasis: identified.providerBasis,
    providerEvidence: identified.providerEvidence,
    customerNoRaw: filtered.billTo.customerNoRaw,
    docNo: identified.docNo,
    docNoKind: identified.docNoKind,
    subtotal: filtered.subtotal,
    total: filtered.total,
  }
  const d = ymdToDate(filtered.date)
  if (d) headerData.docDate = d
  const dd = ymdToDate(filtered.deliveryDate)
  if (dd) headerData.deliveryDate = dd
  const ord = ymdToDate(filtered.orderReceivedDate)
  if (ord) headerData.orderReceivedDate = ord
  if (filtered.kind === 'STATEMENT') {
    // ★ P3 §8.1：statementMonth：AI → 上傳時預選 → section 行最遲月份（＋標黃）
    const sm = resolveStatementMonth({
      aiMonth: filtered.statementMonth,
      preselected: doc.statementMonth,
      latestLineMonth: latestStatementLineMonth(filtered),
    })
    if (sm.month) headerData.statementMonth = sm.month
    if (sm.source === 'LINES') readIssues.push('STATEMENT_MONTH_FROM_LINES')
    // 重複偵測（同 Lab＋診所＋醫生＋月）→ readIssues 機器標記（UI 提示「取代舊版」）
    for (let si = 0; si < sectionIdents.length; si++) {
      const i = sectionIdents[si]
      if (!i.complete) continue
      const dup = await findStatementSectionDuplicate(prisma, {
        labId: finalLabId,
        clinicId: i.clinicId,
        providerId: i.providerId,
        statementMonth: sm.month,
        selfDocId: docId,
      })
      if (dup) readIssues.push(sectionDuplicateIssue(si, dup))
    }
    // §3.4：分段齊（無 NEEDS_ASSIGN）→ IN_PROGRESS；否則 NEEDS_REVIEW（headerData 內預設）
    if (sectionIdents.length > 0 && sectionIdents.every((i) => i.complete)) {
      headerData.status = 'IN_PROGRESS'
    }
    headerData.statementKind = effProfile?.statementKind ?? null
  }

  // §5.1.6：寫 docNo 撞 partial unique index（Prisma P2002）→ DUPLICATE + duplicateOfId。
  // 先做一次預查（常見路徑）；真並發撞由 P2002 catch 兜住。
  if (identified.duplicateOfId) {
    await prisma.labDocument.updateMany({
      where: { id: docId, status: 'EXTRACTING' },
      data: { ...headerData, status: 'DUPLICATE', duplicateOfId: identified.duplicateOfId },
    })
    return
  }

  try {
    await prisma.$transaction(
      async (tx: any) => {
        // 先條件寫頭部：讀單途中被作廢／合併（唔再係 EXTRACTING）→ 放棄（唔建行、唔翻生）
        const claimed = await tx.labDocument.updateMany({ where: { id: docId, status: 'EXTRACTING' }, data: headerData })
        if (claimed.count === 0) throw new ExtractAbandoned()
        // 重讀場景兜底：行應該唔存在（只有成功先建過行，而成功後唔會再入呢度）
        await tx.labDocumentLine.deleteMany({ where: { documentId: docId } })
        if (filtered.kind === 'INVOICE') {
          const creates: Array<Record<string, unknown>> = []
          filtered.groups.forEach((g, gi) => {
            g.lines.forEach((l, li) => {
              creates.push({
                documentId: docId,
                groupIndex: gi,
                lineIndex: li,
                patientNameRaw: g.patientNameRaw,
                patientCodeRaw: g.patientCodeRaw,
                patientCode: normLinePatientCode(g.patientCodeRaw),
                labCaseRef: g.labCaseRef,
                description: l.description,
                toothRaw: l.toothRaw,
                qty: l.qty,
                unitPrice: l.unitPrice,
                listPrice: l.listPrice,
                discountRaw: l.discountRaw,
                amount: l.amount,
                isZero: l.amount === 0,
              })
            })
          })
          if (creates.length > 0) await tx.labDocumentLine.createMany({ data: creates })
        }
        if (filtered.kind === 'STATEMENT') {
          // 重讀場景兜底：清舊分段（行 cascade）再重建
          await tx.labStatementLine.deleteMany({ where: { section: { documentId: docId } } })
          await tx.labStatementSection.deleteMany({ where: { documentId: docId } })
          createdSectionIds = await createStatementSections(tx, docId, {
            sections: filtered.sections,
            idents: sectionIdents,
            clinicShortNames: sectionClinicShortNames,
            normPatientCode: (raw, shortName) => normPatientCode(raw, shortName),
          })
        }
      },
      { timeout: 30_000 },
    )
  } catch (e: any) {
    if (e instanceof ExtractAbandoned) return
    if (e?.code === 'P2002') {
      // 並發：另一張同 Lab＋單號先寫入（partial unique index 兜住）
      const winner = await prisma.labDocument.findFirst({
        where: {
          labId: identified.labId,
          docNo: identified.docNo,
          id: { not: docId },
          status: { notIn: ['VOID', 'DUPLICATE'] },
        },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      })
      await prisma.labDocument.updateMany({
        where: { id: docId, status: 'EXTRACTING' },
        data: { ...headerData, status: 'DUPLICATE', duplicateOfId: winner?.id ?? null },
      })
      return
    }
    throw e
  }

  // ★ P3 §8.1：識別齊（Lab＋診所＋醫生）嘅分段 → 自動 reconcile（best-effort；失敗分段留 PENDING 人手可重跑）
  if (filtered.kind === 'STATEMENT' && createdSectionIds.length > 0) {
    for (let si = 0; si < createdSectionIds.length; si++) {
      if (!sectionIdents[si]?.complete) continue
      await autoReconcileIfReady(prisma, createdSectionIds[si], doc.uploadedBy ?? null, 'auto', '[labdoc:extract]')
    }
  }
}

/** 讀單途中文件已唔係 EXTRACTING（作廢／合併）→ 放棄寫入。 */
class ExtractAbandoned extends Error {}

function unionStrings(arr: string[]): string[] {
  return [...new Set(arr.filter((s): s is string => typeof s === 'string'))]
}

// ------------------------------------------------------------------
// Sweep（§5.1：cron 每 5 分鐘）
// ------------------------------------------------------------------
export interface SweepResult {
  staleExtracting: number
  failed: number
  retriggered: number
}

export async function runLabDocSweep(now: Date = new Date(), opts: RunOpts = {}): Promise<SweepResult> {
  const res: SweepResult = { staleExtracting: 0, failed: 0, retriggered: 0 }

  // EXTRACTING AND heartbeatAt < now-5min → 當失敗
  const staleCutoff = new Date(now.getTime() - SWEEP_STALE_MS)
  const stale = await prisma.labDocument.findMany({
    where: {
      status: 'EXTRACTING',
      OR: [{ heartbeatAt: { lt: staleCutoff } }, { heartbeatAt: null }],
    },
    select: { id: true, extractAttempts: true },
  })
  const staleBackToUploaded: string[] = []
  for (const d of stale) {
    res.staleExtracting++
    const attempts = d.extractAttempts + 1
    if (attempts >= LABDOC_MAX_ATTEMPTS) {
      await prisma.labDocument.updateMany({
        where: { id: d.id },
        data: { status: 'EXTRACT_FAILED', extractAttempts: attempts, extractError: 'stale_heartbeat', version: { increment: 1 } },
      })
      res.failed++
    } else {
      // 回 UPLOADED（再觸發資格）＋ 30 秒後重讀（process 仲活）；
      // process 死咗嘅話呢個 timer 冇咗，下次 sweep 再兜
      await prisma.labDocument.updateMany({
        where: { id: d.id },
        data: { status: 'UPLOADED', extractAttempts: attempts, extractError: 'stale_heartbeat', version: { increment: 1 } },
      })
      staleBackToUploaded.push(d.id)
      const p = sleep(opts.retryDelayMs ?? LABDOC_RETRY_MS).then(() => runLabDocExtract(d.id, opts))
      track(p.catch(() => undefined))
      res.retriggered++
    }
  }

  // UPLOADED AND createdAt < now-2min → 再觸發（EXTRACT_FAILED 唔喺內 — T17：唔會自動再試）
  // 排除本輪先由 stale 打回 UPLOADED 嘅（已經排咗重讀，唔雙觸發）
  const uploadCutoff = new Date(now.getTime() - SWEEP_UPLOAD_MS)
  const pending = await prisma.labDocument.findMany({
    where: {
      status: 'UPLOADED',
      createdAt: { lt: uploadCutoff },
      ...(staleBackToUploaded.length > 0 ? { id: { notIn: staleBackToUploaded } } : {}),
    },
    select: { id: true },
  })
  for (const d of pending) {
    const p = runLabDocExtract(d.id, opts).catch(() => undefined)
    track(p)
    res.retriggered++
  }

  return res
}

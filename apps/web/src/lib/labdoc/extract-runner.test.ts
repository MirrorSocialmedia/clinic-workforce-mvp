/**
 * cwm-labdoc P2 — 讀單 runner / sweep 測試（§5.1；T17 相鄰）
 * 跑法: npx tsx --test src/lib/labdoc/extract-runner.test.ts
 *
 * fake prisma（monkey-patch pattern 照 upload-route.test.ts）＋ __setLabDocExtractFn stub
 * ＋ 真加密寫碟（tmp LAB_DOC_DIR）＋ 真 pdfjs 文字層（fixture sample-text.pdf 2 頁）。
 *
 * 覆蓋：
 *   - T17：stub timeout ×3 → EXTRACT_FAILED（attempts=3、extractError='timeout'）；sweep 唔會再自動試
 *   - not_configured（真 client 路徑，env 未設）→ 3 次 → EXTRACT_FAILED 'not_configured'
 *   - 成功：TEXT 合併 call → NEEDS_REVIEW；識別（NAME）、docNo 正規化、行寫入、readIssues 合併
 *   - §6.2/§6.3/§6.5 wiring：CUSTOMER_NO 帶出 clinic+provider；CLINIC_ALIAS+DOCTOR_ALIAS；
 *     patientCode 純數字補前綴（TW007159）／字母前綴補零（TKW002004）
 *   - T18（runner 層）：lab.nameRaw 含銀行帳號 → extractedJson null 化 + SENSITIVE_REMOVED；docNoRaw 保留
 *   - truncated → 自動分頁再叫（唔計失敗）
 *   - bad_response（zod 再驗證）→ 3 次 → EXTRACT_FAILED
 *   - claim 並發：兩個 run 一個 claimed 一個 skipped；EXTRACTING 中唔會再 claim
 *   - sweep：stale EXTRACTING（attempts=2 → 失敗；attempts=1 → 回 UPLOADED 重讀）；UPLOADED>2min 再觸發
 *   - P2002 並發撞單號 → DUPLICATE + duplicateOfId
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { prisma } from '../prisma'
import { __setLabDocExtractFn, resetLabdocLlmStats } from './llm-client'
import {
  runLabDocExtract,
  runLabDocSweep,
  __drainLabDocExtractions,
  type RunOpts,
} from './extract'
import { buildPageKey, buildStorageKey, saveEncrypted } from './storage'
import { normClinicName, normDoctor } from './identify'

type Any = any

const FIXTURE = join(process.cwd(), 'test/fixtures/labdoc/sample-text.pdf') // 2 頁、有文字層
const PDF_BUF = readFileSync(FIXTURE)

// ── fake state ──────────────────────────────────────────────
interface DocRow {
  id: string
  kind: string
  status: string
  labId: string | null
  labBasis: string | null
  labNameRaw: string | null
  payeeRaw: string | null
  payeeIsNew: boolean
  clinicId: string | null
  clinicBasis: string | null
  clinicEvidence: string | null
  providerId: string | null
  providerBasis: string | null
  providerEvidence: string | null
  customerNoRaw: string | null
  docNo: string | null
  docNoKind: string | null
  docDate: Date | null
  deliveryDate: Date | null
  orderReceivedDate: Date | null
  statementMonth: string | null
  subtotal: number | null
  total: number | null
  extractedJson: Any
  readIssues: string[]
  extractSource: string | null
  extractError: string | null
  extractAttempts: number
  heartbeatAt: Date | null
  duplicateOfId: string | null
  version: number
  uploadedBy: string
  createdAt: Date
  updatedAt: Date
}
interface PageRow {
  id: string
  documentId: string
  fileId: string
  pageNo: number
  sortOrder: number
  file?: Any
}
interface State {
  seq: number
  docs: Record<string, DocRow>
  pages: PageRow[]
  files: Record<string, Any>
  aliases: Array<{ id: string; labId: string; kind: string; rawNorm: string }>
  labs: Array<{ id: string; name: string; isActive: boolean }>
  profiles: Record<string, Any>
  lines: Any[]
  clinics: Any[]
  providers: Any[]
  clinicAliases: Array<{ id: string; rawNorm: string; clinicId: string }>
  providerAliases: Array<{ id: string; rawNorm: string; providerId: string }>
  customerNos: Array<{ id: string; labId: string; customerNo: string; clinicId: string; providerId: string | null }>
  p2002ForDocId: string | null
  suppressDupPreflight: boolean
  dupFindSeq: number
}
let state: State
const nextId = (p: string) => `${p}${String(++state.seq).padStart(21, '0')}`

function freshDoc(id: string, over: Partial<DocRow> = {}): DocRow {
  return {
    id,
    kind: 'INVOICE',
    status: 'UPLOADED',
    labId: null,
    labBasis: null,
    labNameRaw: null,
    payeeRaw: null,
    payeeIsNew: false,
    clinicId: null,
    clinicBasis: null,
    clinicEvidence: null,
    providerId: null,
    providerBasis: null,
    providerEvidence: null,
    customerNoRaw: null,
    docNo: null,
    docNoKind: null,
    docDate: null,
    deliveryDate: null,
    orderReceivedDate: null,
    statementMonth: null,
    subtotal: null,
    total: null,
    extractedJson: null,
    readIssues: [],
    extractSource: null,
    extractError: null,
    extractAttempts: 0,
    heartbeatAt: null,
    duplicateOfId: null,
    version: 0,
    uploadedBy: 'u-test',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  }
}

// ── where matching（覆蓋 runner/sweep 用到嘅 shape） ─────────
function docMatches(d: DocRow, where: Any): boolean {
  if (!where) return true
  if (where.id !== undefined) {
    if (typeof where.id === 'string') {
      if (d.id !== where.id) return false
    } else {
      if (where.id.in && !where.id.in.includes(d.id)) return false
      if (where.id.not && d.id === where.id.not) return false
      if (where.id.notIn && where.id.notIn.includes(d.id)) return false
    }
  }
  if (where.status !== undefined) {
    if (where.status.in && !where.status.in.includes(d.status)) return false
    if (!where.status.in && !where.status.notIn && d.status !== where.status) return false
    if (where.status.notIn && where.status.notIn.includes(d.status)) return false
  }
  if (where.labId !== undefined && d.labId !== where.labId) return false
  if (where.docNo !== undefined && d.docNo !== where.docNo) return false
  if (where.createdAt?.lt && !(d.createdAt < where.createdAt.lt)) return false
  if (where.heartbeatAt?.lt && !(d.heartbeatAt === null || d.heartbeatAt < where.heartbeatAt.lt)) return false
  if (where.OR && !where.OR.some((o: Any) => docMatches(d, o))) return false
  return true
}

function applyData(d: DocRow, data: Any): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in (v as Any)) {
      ;(d as Any)[k] = ((d as Any)[k] ?? 0) + (v as Any).increment
    } else {
      ;(d as Any)[k] = v
    }
  }
  d.updatedAt = new Date()
}

// ── fake prisma ─────────────────────────────────────────────
const fakes: Record<string, Any> = {
  labDocument: {
    updateMany: async ({ where, data }: Any) => {
      let n = 0
      for (const d of Object.values(state.docs)) {
        if (docMatches(d, where)) {
          applyData(d, data)
          n++
        }
      }
      return { count: n }
    },
    update: async ({ where, data }: Any) => {
      const d = state.docs[where.id]
      if (!d) throw new Error('P2025: doc not found')
      applyData(d, data)
      return d
    },
    findUnique: async ({ where, include }: Any) => {
      const d = state.docs[where.id]
      if (!d) return null
      const clone: Any = structuredClone(d)
      if (include?.pages) {
        const pages = state.pages
          .filter((p) => p.documentId === d.id)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((p) => structuredClone(p))
        if (include.pages.include?.file) {
          for (const p of pages) p.file = state.files[p.fileId]
        }
        clone.pages = pages
      }
      return clone
    },
    findMany: async ({ where, orderBy }: Any) => {
      let rows = Object.values(state.docs).filter((d) => docMatches(d, where))
      if (orderBy) {
        const [key, dir] = Object.entries(orderBy)[0]
        rows = [...rows].sort((a, b) => ((a as Any)[key] < (b as Any)[key] ? -1 : 1) * (dir === 'desc' ? -1 : 1))
      }
      return rows
    },
    findFirst: async ({ where }: Any) => {
      if (where?.docNo && where?.id?.not) {
        state.dupFindSeq++
        if (state.suppressDupPreflight && state.dupFindSeq === 1) return null // 模擬 preflight 與寫入之間嘅 race
      }
      return Object.values(state.docs).filter((d) => docMatches(d, where)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0] ?? null
    },
  },
  labFile: {
    findMany: async ({ where }: Any) =>
      Object.values(state.files).filter((f) => (where?.id?.in ? where.id.in.includes(f.id) : true)),
  },
  labAlias: {
    findFirst: async ({ where }: Any) => {
      const hits = state.aliases.filter(
        (a) =>
          (!where.kind || a.kind === where.kind) &&
          (!where.rawNorm || a.rawNorm === where.rawNorm) &&
          (!where.labId || a.labId === where.labId),
      )
      return hits[0] ?? null
    },
  },
  lab: {
    findMany: async () => state.labs.filter((l) => l.isActive),
  },
  labCustomerNo: {
    findFirst: async ({ where }: Any) =>
      state.customerNos.find(
        (c) => (!where.labId || c.labId === where.labId) && (!where.customerNo || c.customerNo === where.customerNo),
      ) ?? null,
  },
  clinicNameAlias: {
    findFirst: async ({ where }: Any) =>
      state.clinicAliases.find((a) => a.rawNorm === where.rawNorm) ?? null,
  },
  providerNameAlias: {
    findFirst: async ({ where }: Any) =>
      state.providerAliases.find((a) => a.rawNorm === where.rawNorm) ?? null,
  },
  clinic: {
    findMany: async () => state.clinics,
    findUnique: async ({ where }: Any) => state.clinics.find((c) => c.id === where.id) ?? null,
  },
  provider: {
    findMany: async () => state.providers.filter((p) => p.isActive),
  },
  labProfile: {
    findUnique: async ({ where }: Any) => state.profiles[where.labId] ?? null,
  },
  labDocumentLine: {
    deleteMany: async ({ where }: Any) => {
      const before = state.lines.length
      state.lines = state.lines.filter((l) => l.documentId !== where.documentId)
      return { count: before - state.lines.length }
    },
    createMany: async ({ data }: Any) => {
      for (const d of data) state.lines.push({ id: nextId('line'), status: 'UNMATCHED', ...d })
      return { count: data.length }
    },
  },
  $transaction: async (fn: Any, _opts?: Any) => {
    if (state.p2002ForDocId) {
      const realUpdate = fakes.labDocumentLine
      const tx: Any = {
        labDocumentLine: realUpdate,
        labDocument: {
          update: async ({ where, data }: Any) => {
            if (where.id === state.p2002ForDocId) {
              const e: Any = new Error('Unique constraint failed')
              e.code = 'P2002'
              throw e
            }
            const d = state.docs[where.id]
            if (!d) throw new Error('P2025')
            applyData(d, data)
            return d
          },
        },
      }
      return fn(tx)
    }
    return fn(fakes)
  },
}

// ── env / 碟 ────────────────────────────────────────────────
let tmp = ''
const OLD_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'LAB_DOC_DIR',
  'LAB_DOC_ENC_KEY',
  'LAB_DOC_ENC_KID',
  'WA_INBOX_LABDOC_URL',
  'INTERNAL_LLM_SECRET',
  'INTERNAL_LLM_KID',
]
const saved: [Any, string, Any][] = []

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'labdoc-runner-test-'))
  for (const k of ENV_KEYS) OLD_ENV[k] = process.env[k]
  process.env.LAB_DOC_DIR = tmp
  process.env.LAB_DOC_ENC_KEY = randomBytes(32).toString('base64')
  process.env.LAB_DOC_ENC_KID = 'k1'
  process.env.WA_INBOX_LABDOC_URL = 'http://127.0.0.1:9/unused'
  process.env.INTERNAL_LLM_SECRET = randomBytes(32).toString('base64')
  process.env.INTERNAL_LLM_KID = 'k1'
  for (const k of Object.keys(fakes)) {
    saved.push([prisma, k, (prisma as Any)[k]])
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})
after(() => {
  __setLabDocExtractFn(null)
  for (const [obj, k, orig] of saved) Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  for (const k of ENV_KEYS) {
    if (OLD_ENV[k] === undefined) delete process.env[k]
    else process.env[k] = OLD_ENV[k]
  }
  rmSync(tmp, { recursive: true, force: true })
})
beforeEach(() => {
  state = {
    seq: 0,
    docs: {},
    pages: [],
    files: {},
    aliases: [],
    labs: [{ id: 'labexcel0000000000000000001', name: 'Excel', isActive: true }],
    profiles: {},
    lines: [],
    clinics: [],
    providers: [],
    clinicAliases: [],
    providerAliases: [],
    customerNos: [],
    p2002ForDocId: null,
    suppressDupPreflight: false,
    dupFindSeq: 0,
  }
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  __setLabDocExtractFn(null)
  resetLabdocLlmStats()
})

// ── seed：1 份 2 頁 PDF（真加密上碟 + DB 行） ────────────────
async function seedDoc(over: Partial<DocRow> = {}): Promise<string> {
  const docId = nextId('doc')
  const fileId = nextId('file').slice(0, 25)
  const uploadedAt = new Date()
  const storageKey = buildStorageKey(fileId, uploadedAt)
  await saveEncrypted(storageKey, PDF_BUF)
  for (let pageNo = 1; pageNo <= 2; pageNo++) {
    await saveEncrypted(buildPageKey(fileId, uploadedAt, pageNo, 'display'), Buffer.from(`display-${pageNo}`))
  }
  state.files[fileId] = {
    id: fileId,
    sha256: 'aa'.repeat(32),
    mime: 'application/pdf',
    sizeBytes: PDF_BUF.length,
    pageCount: 2,
    hasTextLayer: true,
    storageKey,
    pagesJson: [
      { page: 1, displayKey: buildPageKey(fileId, uploadedAt, 1, 'display'), thumbKey: 't1', width: 100, height: 100, textChars: 50 },
      { page: 2, displayKey: buildPageKey(fileId, uploadedAt, 2, 'display'), thumbKey: 't2', width: 100, height: 100, textChars: 50 },
    ],
    uploadedAt,
    uploadedBy: 'u-test',
    purgedAt: null,
  }
  for (let pageNo = 1; pageNo <= 2; pageNo++) {
    state.pages.push({ id: nextId('pg'), documentId: docId, fileId, pageNo, sortOrder: pageNo - 1 })
  }
  state.docs[docId] = freshDoc(docId, { id: docId, ...over })
  return docId
}

const RUN_FAST: RunOpts = { retryDelayMs: 1, heartbeatMs: 25 }

// ── §5.4 測試結果 fixture ───────────────────────────────────
const OK_RESULT: Any = {
  kind: 'INVOICE',
  lab: { nameRaw: 'Excel Dental Laboratory', nameCnRaw: '艾希爾', payeeRaw: 'Excel Ltd' },
  billTo: { nameRaw: '臻善牙科（大圍）', addressRaw: '大圍道1號', customerNoRaw: 'EC-101', shortCodeRaw: 'TW', doctorRaw: 'Dr Ho Ka Chun' },
  docNoRaw: ' inv 260805010 ',
  docNoLabel: 'Invoice No.',
  dateRaw: '05 Aug 2026',
  date: '2026-08-05',
  deliveryDate: '2026-08-06',
  orderReceivedDate: null,
  statementMonth: null,
  groups: [
    {
      patientNameRaw: '陳大文',
      patientCodeRaw: 'TW7159',
      labCaseRef: null,
      lines: [{ description: 'Crown Zirconia', toothRaw: '16', qty: 2, unitPrice: 300, listPrice: null, discountRaw: null, amount: 600 }],
    },
  ],
  sections: [],
  subtotal: 600,
  total: 600,
  readIssues: ['LAB_NAME_PARTIAL:footer'],
}

describe('runner — 失敗路徑', () => {
  it('T17：stub timeout ×3 → EXTRACT_FAILED；sweep 唔會再自動試', async () => {
    const docId = await seedDoc()
    __setLabDocExtractFn(async () => ({ outcome: null, nullReason: 'timeout' }))
    const r = await runLabDocExtract(docId, RUN_FAST)
    assert.equal(r, 'claimed')
    await __drainLabDocExtractions()

    const d = state.docs[docId]
    assert.equal(d.status, 'EXTRACT_FAILED')
    assert.equal(d.extractAttempts, 3)
    assert.equal(d.extractError, 'timeout')
    assert.equal(d.extractedJson, null)

    const sweep = await runLabDocSweep(new Date(), RUN_FAST)
    assert.deepEqual(sweep, { staleExtracting: 0, failed: 0, retriggered: 0 })
    assert.equal(state.docs[docId].status, 'EXTRACT_FAILED') // 原封不動
    assert.equal(state.docs[docId].extractAttempts, 3)
  })

  it('not_configured（真 client 路徑、env 未設）→ 3 次 → EXTRACT_FAILED', async () => {
    const docId = await seedDoc()
    delete process.env.WA_INBOX_LABDOC_URL
    delete process.env.INTERNAL_LLM_SECRET
    try {
      const r = await runLabDocExtract(docId, RUN_FAST)
      assert.equal(r, 'claimed')
      await __drainLabDocExtractions()
      const d = state.docs[docId]
      assert.equal(d.status, 'EXTRACT_FAILED')
      assert.equal(d.extractError, 'not_configured')
      assert.equal(d.extractAttempts, 3)
    } finally {
      process.env.WA_INBOX_LABDOC_URL = 'http://127.0.0.1:9/unused'
      process.env.INTERNAL_LLM_SECRET = randomBytes(32).toString('base64')
    }
  })

  it('bad_response（zod 再驗證攞到必填缺）→ 3 次 → EXTRACT_FAILED', async () => {
    const docId = await seedDoc()
    const bad = structuredClone(OK_RESULT)
    delete bad.total
    __setLabDocExtractFn(async () => ({ outcome: { result: bad, reason: null }, nullReason: null }))
    await runLabDocExtract(docId, RUN_FAST)
    await __drainLabDocExtractions()
    const d = state.docs[docId]
    assert.equal(d.status, 'EXTRACT_FAILED')
    assert.equal(d.extractError, 'bad_response')
    assert.equal(d.extractAttempts, 3)
  })

  it('claim 守衛：EXTRACTING 中唔會再 claim；並發兩個 run 一個 claimed 一個 skipped', async () => {
    const docId = await seedDoc({ status: 'EXTRACTING', heartbeatAt: new Date() })
    assert.equal(await runLabDocExtract(docId, RUN_FAST), 'skipped')

    const docId2 = await seedDoc()
    __setLabDocExtractFn(async () => ({ outcome: { result: structuredClone(OK_RESULT), reason: null }, nullReason: null }))
    const [a, b] = await Promise.all([runLabDocExtract(docId2, RUN_FAST), runLabDocExtract(docId2, RUN_FAST)])
    const results = [a, b].sort()
    assert.deepEqual(results, ['claimed', 'skipped'])
    await __drainLabDocExtractions()
    assert.equal(state.docs[docId2].status, 'NEEDS_REVIEW')
  })
})

describe('runner — 成功路徑', () => {
  it('TEXT 2 頁合併 call → NEEDS_REVIEW；識別 NAME、docNo 正規化、行寫入、readIssues 合併', async () => {
    const docId = await seedDoc()
    const calls: Any[] = []
    __setLabDocExtractFn(async (req) => {
      calls.push(req)
      return { outcome: { result: structuredClone(OK_RESULT), reason: null }, nullReason: null }
    })
    await runLabDocExtract(docId, RUN_FAST)
    await __drainLabDocExtractions()

    // §5.1.3：TEXT 模式（sample-text.pdf 全頁文字層）；§5.2：單 call、頁之間 <<<PAGE n>>>
    assert.equal(calls.length, 1)
    assert.equal(calls[0].mode, 'TEXT')
    assert.equal(calls[0].kindHint, 'INVOICE')
    assert.equal(calls[0].labHint, null)
    assert.ok(calls[0].text!.includes('<<<PAGE 2>>>'))
    assert.equal(calls[0].images, null)

    const d = state.docs[docId]
    assert.equal(d.status, 'NEEDS_REVIEW')
    assert.equal(d.extractSource, 'TEXT')
    assert.equal(d.extractError, null)
    assert.ok(d.heartbeatAt instanceof Date) // claim 時 set 過
    // §6.1：'Excel Dental Laboratory' → norm 'excel' ↔ Lab 'Excel' → NAME
    assert.equal(d.labId, 'labexcel0000000000000000001')
    assert.equal(d.labBasis, 'NAME')
    // §6.1.4：payee 'Excel Ltd' → norm 'excel' 唔喺 PAYEE alias → payeeIsNew
    assert.equal(d.payeeIsNew, true)
    assert.equal(d.payeeRaw, 'Excel Ltd')
    // §6.4：' inv 260805010 ' → INV260805010；label 無 case → INVOICE_NO
    assert.equal(d.docNo, 'INV260805010')
    assert.equal(d.docNoKind, 'INVOICE_NO')
    assert.equal(d.duplicateOfId, null)
    assert.equal(d.docDate?.toISOString().slice(0, 10), '2026-08-05')
    assert.equal(d.deliveryDate?.toISOString().slice(0, 10), '2026-08-06')
    assert.equal(d.customerNoRaw, 'EC-101')
    assert.equal(d.labNameRaw, 'Excel Dental Laboratory')
    assert.equal(d.subtotal, 600)
    assert.equal(d.total, 600)
    // §5.5 全過 → 無系統 token；readIssues = LLM 自己嗰啲
    assert.deepEqual(d.readIssues, ['LAB_NAME_PARTIAL:footer'])
    // extractedJson = AI 輸出（呢次無敏感命中 → 原樣）
    assert.deepEqual(d.extractedJson, structuredClone(OK_RESULT))
    // 行：1 組 1 行
    const lines = state.lines.filter((l) => l.documentId === docId)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].groupIndex, 0)
    assert.equal(lines[0].lineIndex, 0)
    assert.equal(lines[0].description, 'Crown Zirconia')
    assert.equal(Number(lines[0].amount), 600)
    assert.equal(lines[0].status, 'UNMATCHED')
    assert.equal(lines[0].patientCodeRaw, 'TW7159')
  })

  it('T18（runner 層）：lab.nameRaw 含 040-543613-838 → 刪；docNoRaw INV-260805010 → 保留', async () => {
    const docId = await seedDoc()
    const r18: Any = structuredClone(OK_RESULT)
    r18.lab.nameRaw = '禾呈大圍 040-543613-838'
    r18.lab.nameCnRaw = null
    r18.docNoRaw = 'INV-260805010'
    __setLabDocExtractFn(async () => ({ outcome: { result: r18, reason: null }, nullReason: null }))
    await runLabDocExtract(docId, RUN_FAST)
    await __drainLabDocExtractions()

    const d = state.docs[docId]
    assert.equal(d.status, 'NEEDS_REVIEW')
    assert.equal(d.extractedJson.lab.nameRaw, null) // 敏感刪
    assert.equal(d.labNameRaw, null)
    assert.ok(d.readIssues.includes('SENSITIVE_REMOVED:lab.nameRaw'))
    assert.equal(d.docNo, 'INV-260805010') // F-03：單號唔查 → 保留（§6.4 正規化保留 hyphen）
    // 識別：nameRaw 刪咗 → 無 alias/NAME 命中 → labId 保持 null（upload 未揀）
    assert.equal(d.labId, null)
    assert.equal(d.labBasis, null)
  })

  it('LAB_DOC_DIR 加密存底 + LabProfile.extractionHint → labHint 傳入（cap 前）', async () => {
    const docId = await seedDoc({ labId: 'labexcel0000000000000000001' })
    state.profiles['labexcel0000000000000000001'] = {
      extractionHint: 'Modern 名後 4 位係病人編號',
      statementKind: 'INVOICE_LIST',
      defaultDocNoKind: 'INVOICE_NO',
    }
    const calls: Any[] = []
    __setLabDocExtractFn(async (req) => {
      calls.push(req)
      return { outcome: { result: structuredClone(OK_RESULT), reason: null }, nullReason: null }
    })
    await runLabDocExtract(docId, RUN_FAST)
    await __drainLabDocExtractions()
    assert.equal(calls[0].labHint, 'Modern 名後 4 位係病人編號')
    assert.equal(state.docs[docId].status, 'NEEDS_REVIEW')
  })

  it('§6.2/§6.3/§6.5 wiring：CUSTOMER_NO 命中 → clinic+provider 同時帶出；純數字 patientCode 補 shortName 前綴', async () => {
    const docId = await seedDoc()
    state.customerNos = [
      { id: 'cn010000000000000000001', labId: 'labexcel0000000000000000001', customerNo: 'EC-101', clinicId: 'clintw0000000000000000001', providerId: 'provho0000000000000000001' },
    ]
    state.clinics = [
      { id: 'clintw0000000000000000001', name: '臻善牙科（大圍）', shortName: 'TW', address: '大圍道1號', addressEn: null },
    ]
    const r1 = structuredClone(OK_RESULT)
    r1.groups[0].patientCodeRaw = '7159'
    __setLabDocExtractFn(async () => ({ outcome: { result: r1, reason: null }, nullReason: null }))
    await runLabDocExtract(docId, RUN_FAST)
    await __drainLabDocExtractions()

    const d = state.docs[docId]
    assert.equal(d.status, 'NEEDS_REVIEW')
    // §6.2.1：CUSTOMER_NO 係第一優先 → clinic 同 provider 一次過帶出
    assert.equal(d.clinicId, 'clintw0000000000000000001')
    assert.equal(d.clinicBasis, 'CUSTOMER_NO')
    assert.equal(d.clinicEvidence, 'EC-101')
    assert.equal(d.providerId, 'provho0000000000000000001')
    assert.equal(d.providerBasis, 'CUSTOMER_NO')
    assert.equal(d.providerEvidence, 'Dr Ho Ka Chun')
    // §6.5：純數字 '7159' + 命中 clinic shortName 'TW' → TW007159（補零 6 位）
    const lines = state.lines.filter((l) => l.documentId === docId)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].patientCodeRaw, '7159')
    assert.equal(lines[0].patientCode, 'TW007159')
  })

  it('§6.2/§6.3 wiring：CLINIC_ALIAS + DOCTOR_ALIAS 命中；字母前綴 patientCode 去前置 0 補 6 位', async () => {
    const docId = await seedDoc()
    state.clinicAliases = [
      { id: 'cal000000000000000000001', rawNorm: normClinicName('臻善牙科（大圍）'), clinicId: 'clinty0000000000000000001' },
    ]
    state.providerAliases = [
      { id: 'pal000000000000000000001', rawNorm: normDoctor('Dr Ho Ka Chun'), providerId: 'provyiu0000000000000000001' },
    ]
    state.clinics = [
      { id: 'clinty0000000000000000001', name: '屯門牙科診所', shortName: 'TY', address: null, addressEn: null },
    ]
    const r2 = structuredClone(OK_RESULT)
    r2.groups[0].patientCodeRaw = 'TKW02004'
    __setLabDocExtractFn(async () => ({ outcome: { result: r2, reason: null }, nullReason: null }))
    await runLabDocExtract(docId, RUN_FAST)
    await __drainLabDocExtractions()

    const d = state.docs[docId]
    assert.equal(d.status, 'NEEDS_REVIEW')
    assert.equal(d.clinicId, 'clinty0000000000000000001')
    assert.equal(d.clinicBasis, 'CLINIC_ALIAS')
    assert.equal(d.clinicEvidence, '臻善牙科（大圍）')
    assert.equal(d.providerId, 'provyiu0000000000000000001')
    assert.equal(d.providerBasis, 'DOCTOR_ALIAS')
    assert.equal(d.providerEvidence, 'Dr Ho Ka Chun')
    // §6.5：字母前綴 + 前置 0 正規化 → TKW002004
    const lines = state.lines.filter((l) => l.documentId === docId)
    assert.equal(lines[0].patientCodeRaw, 'TKW02004')
    assert.equal(lines[0].patientCode, 'TKW002004')
  })
})

describe('runner — truncated 分頁再叫（§5.2）', () => {
  it('2 頁 TEXT 合併 call truncated → 自動逐頁再叫（唔計失敗）→ 合併成功', async () => {
    const docId = await seedDoc()
    const calls: Any[] = []
    const page1: Any = {
      ...structuredClone(OK_RESULT),
      total: null,
      subtotal: null,
      readIssues: [],
    }
    const page2: Any = {
      ...structuredClone(OK_RESULT),
      docNoRaw: null,
      date: null,
      dateRaw: null,
      lab: { nameRaw: null, nameCnRaw: null, payeeRaw: null },
      readIssues: [],
    }
    page1.groups = [page1.groups[0]]
    page2.groups = [
      {
        patientNameRaw: '李細明',
        patientCodeRaw: 'TW7160',
        labCaseRef: null,
        lines: [{ description: 'Bridge', toothRaw: '21', qty: 1, unitPrice: 400, listPrice: null, discountRaw: null, amount: 400 }],
      },
    ]
    __setLabDocExtractFn(async (req) => {
      calls.push(req)
      if (req.text && req.text.includes('<<<PAGE 2>>>')) {
        return { outcome: { result: null, reason: 'truncated' }, nullReason: null }
      }
      // 逐頁：page 1 先 page 2（text 順序）
      if (calls.length === 2) return { outcome: { result: structuredClone(page1), reason: null }, nullReason: null }
      return { outcome: { result: structuredClone(page2), reason: null }, nullReason: null }
    })
    await runLabDocExtract(docId, RUN_FAST)
    await __drainLabDocExtractions()

    assert.equal(calls.length, 3) // 1 合併 + 2 逐頁
    assert.ok(calls[0].text!.includes('<<<PAGE 2>>>'))
    assert.ok(!calls[1].text!.includes('<<<PAGE'))
    assert.ok(!calls[2].text!.includes('<<<PAGE'))
    const d = state.docs[docId]
    assert.equal(d.status, 'NEEDS_REVIEW')
    assert.equal(d.extractAttempts, 0) // 冇計失敗
    // 合併：頭部 first-non-null（docNo/date 來自 page1）、total last-non-null、groups concat
    assert.equal(d.docNo, 'INV260805010')
    assert.equal(d.docDate?.toISOString().slice(0, 10), '2026-08-05')
    assert.equal(d.total, 600)
    assert.equal(d.extractedJson.groups.length, 2)
    assert.equal(state.lines.filter((l) => l.documentId === docId).length, 2)
  })
})

describe('sweep — §5.1 安全網', () => {
  it('stale EXTRACTING（attempts=2）→ 當失敗第 3 次 → EXTRACT_FAILED（stale_heartbeat）', async () => {
    const docId = await seedDoc({ status: 'EXTRACTING', heartbeatAt: new Date(Date.now() - 10 * 60_000), extractAttempts: 2 })
    __setLabDocExtractFn(async () => {
      throw new Error('sweep 失敗路徑唔應該再打 proxy')
    })
    const res = await runLabDocSweep(new Date(), RUN_FAST)
    assert.deepEqual(res, { staleExtracting: 1, failed: 1, retriggered: 0 })
    const d = state.docs[docId]
    assert.equal(d.status, 'EXTRACT_FAILED')
    assert.equal(d.extractAttempts, 3)
    assert.equal(d.extractError, 'stale_heartbeat')
  })

  it('stale EXTRACTING（attempts=1）→ 回 UPLOADED + 30 秒後重讀（timer 1ms）→ NEEDS_REVIEW', async () => {
    const docId = await seedDoc({ status: 'EXTRACTING', heartbeatAt: new Date(Date.now() - 10 * 60_000), extractAttempts: 1 })
    __setLabDocExtractFn(async () => ({ outcome: { result: structuredClone(OK_RESULT), reason: null }, nullReason: null }))
    const res = await runLabDocSweep(new Date(), RUN_FAST)
    assert.deepEqual(res, { staleExtracting: 1, failed: 0, retriggered: 1 })
    await __drainLabDocExtractions()
    const d = state.docs[docId]
    assert.equal(d.status, 'NEEDS_REVIEW')
    assert.equal(d.extractAttempts, 2) // sweep 路徑計晒嗰次死 attempt（1+1），唔重置（sweep 設計：防無限重試）
  })

  it('UPLOADED 超過 2 分鐘 → 再觸發；EXTRACT_FAILED 唔會觸發（T17 尾句）', async () => {
    const oldUploaded = await seedDoc({ createdAt: new Date(Date.now() - 5 * 60_000) })
    const failedOne = await seedDoc({ status: 'EXTRACT_FAILED', extractAttempts: 3, extractError: 'timeout', createdAt: new Date(Date.now() - 5 * 60_000) })
    const freshUploaded = await seedDoc() // createdAt = now → 未夠 2 分鐘
    __setLabDocExtractFn(async () => ({ outcome: { result: structuredClone(OK_RESULT), reason: null }, nullReason: null }))
    const res = await runLabDocSweep(new Date(), RUN_FAST)
    assert.equal(res.retriggered, 1)
    await __drainLabDocExtractions()
    assert.equal(state.docs[oldUploaded].status, 'NEEDS_REVIEW')
    assert.equal(state.docs[failedOne].status, 'EXTRACT_FAILED') // 原封不動
    assert.equal(state.docs[freshUploaded].status, 'UPLOADED') // 未夠 2 分鐘
  })
})

describe('§5.1.6 — docNo 撞 partial unique index（P2002）→ DUPLICATE', () => {
  it('preflight 先搵到重複 → 直接 DUPLICATE（唔入 transaction）', async () => {
    const winnerId = await seedDoc({
      status: 'NEEDS_REVIEW',
      labId: 'labexcel0000000000000000001',
      docNo: 'INV260805010',
      docNoKind: 'INVOICE_NO',
      createdAt: new Date(Date.now() - 60_000),
    })
    const loserId = await seedDoc()
    __setLabDocExtractFn(async () => ({ outcome: { result: structuredClone(OK_RESULT), reason: null }, nullReason: null }))
    await runLabDocExtract(loserId, RUN_FAST)
    await __drainLabDocExtractions()
    const d = state.docs[loserId]
    assert.equal(d.status, 'DUPLICATE')
    assert.equal(d.duplicateOfId, winnerId)
  })

  it('preflight 搵唔到（race）→ 寫入時 P2002 → catch → DUPLICATE', async () => {
    const winnerId = await seedDoc({
      status: 'NEEDS_REVIEW',
      labId: 'labexcel0000000000000000001',
      docNo: 'INV260805010',
      docNoKind: 'INVOICE_NO',
      createdAt: new Date(Date.now() - 60_000),
    })
    const loserId = await seedDoc()
    state.suppressDupPreflight = true
    state.p2002ForDocId = loserId
    __setLabDocExtractFn(async () => ({ outcome: { result: structuredClone(OK_RESULT), reason: null }, nullReason: null }))
    await runLabDocExtract(loserId, RUN_FAST)
    await __drainLabDocExtractions()
    const d = state.docs[loserId]
    assert.equal(d.status, 'DUPLICATE')
    assert.equal(d.duplicateOfId, winnerId)
  })
})

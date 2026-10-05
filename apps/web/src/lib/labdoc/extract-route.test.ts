/**
 * cwm-labdoc P2 — 讀單 route 測試：upload 背景觸發（void hook）＋ T18 route 級 ＋ retry route
 * 跑法: npx tsx --test src/lib/labdoc/extract-route.test.ts
 *
 * 寫法跟 upload-route.test.ts（fake prisma monkey-patch ＋ createToken ＋ 直接 import route POST）。
 * 真用：requireAuth（RBAC 真 CONFIG）、processUploadFile（真 sharp/pdfjs fixture）、
 * saveEncrypted/readEncrypted（真 fs → tmp LAB_DOC_DIR）、__setLabDocExtractFn stub。
 *
 * 覆蓋：
 *   - 上傳 401／403（T10 同型）
 *   - T18 route 級：上傳 → stub 讀單（lab.nameRaw 含 040-543613-838、docNoRaw INV-260805010）
 *     → 201 後背景跑完 → DB：nameRaw 刪、SENSITIVE_REMOVED token、docNo 保留、NEEDS_REVIEW
 *   - 未設 LLM env 上傳 → 201 照回（唔卡）→ 背景 3 次 → EXTRACT_FAILED 'not_configured'
 *   - POST /:id/retry：401／404／403／400（非 EXTRACT_FAILED）／503（env 未設）／
 *     202 → 背景再讀成功（attempts 重置）
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '../prisma'
import { createToken } from '../auth'
import { POST as uploadPOST } from '../../app/api/lab-docs/upload/route'
import { POST as retryPOST } from '../../app/api/lab-docs/[id]/retry/route'
import { __setLabDocExtractFn } from './llm-client'
import { __drainLabDocExtractions, type RunOpts } from './extract'
import { buildPageKey, buildStorageKey, saveEncrypted } from './storage'

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
interface State {
  seq: number
  users: Record<string, Any>
  labs: Record<string, Any>
  writeLogs: Record<string, Any>
  files: Record<string, Any>
  fileOrder: Any[]
  docs: Record<string, DocRow>
  pages: Any[]
  lines: Any[]
  auditRows: Any[]
}
let state: State
const nextId = (p: string) => `${p}${String(++state.seq).padStart(21, '0')}`

function freshDoc(id: string, over: Partial<DocRow> = {}): DocRow {
  return {
    id, kind: 'INVOICE', status: 'UPLOADED', labId: null, labBasis: null, labNameRaw: null,
    payeeRaw: null, payeeIsNew: false, clinicId: null, clinicBasis: null, clinicEvidence: null, providerId: null, providerBasis: null, providerEvidence: null, customerNoRaw: null, docNo: null, docNoKind: null,
    docDate: null, deliveryDate: null, orderReceivedDate: null, statementMonth: null,
    subtotal: null, total: null, extractedJson: null, readIssues: [], extractSource: null,
    extractError: null, extractAttempts: 0, heartbeatAt: null, duplicateOfId: null,
    version: 0, uploadedBy: 'u-test', createdAt: new Date(), updatedAt: new Date(), ...over,
  }
}

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

// ── fake prisma（upload route + runner 兩邊都要） ───────────
const fakes: Record<string, Any> = {
  user: {
    findUnique: async ({ where }: Any) => state.users[where.id] ?? null,
  },
  lab: {
    findUnique: async ({ where }: Any) => state.labs[where.id] ?? null,
    findMany: async () => Object.values(state.labs),
  },
  labCustomerNo: { findFirst: async () => null },
  clinicNameAlias: { findFirst: async () => null },
  providerNameAlias: { findFirst: async () => null },
  clinic: { findMany: async () => [], findUnique: async () => null },
  provider: { findMany: async () => [] },
  labDocWriteLog: {
    findUnique: async ({ where }: Any) => state.writeLogs[where.idempotencyKey] ?? null,
    upsert: async ({ where, create, update }: Any) => {
      const k = where.idempotencyKey as string
      if (state.writeLogs[k]) Object.assign(state.writeLogs[k], update)
      else state.writeLogs[k] = { ...create, createdAt: new Date() }
      return state.writeLogs[k]
    },
    update: async ({ where, data }: Any) => {
      const k = where.idempotencyKey as string
      if (state.writeLogs[k]) Object.assign(state.writeLogs[k], data)
      return state.writeLogs[k] ?? null
    },
  },
  labFile: {
    findMany: async ({ where }: Any) => {
      if (where?.sha256?.in) {
        return Object.values(state.files)
          .filter((f) => where.sha256.in.includes(f.sha256) && f.purgedAt === null)
          .map((f) => ({
            sha256: f.sha256,
            uploadedAt: f.uploadedAt,
            uploadedBy: f.uploadedBy,
            pages: (f.pages ?? []).map((p: Any) => ({
              document: state.docs[p.documentId] ? { id: state.docs[p.documentId].id, status: state.docs[p.documentId].status } : null,
            })),
          }))
      }
      if (where?.id?.in) return Object.values(state.files).filter((f) => where.id.in.includes(f.id))
      return Object.values(state.files)
    },
  },
  auditLog: {
    create: async ({ data }: Any) => {
      state.auditRows.push(data)
      return data
    },
  },
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
      if (!d) throw new Error('P2025')
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
          .sort((a: Any, b: Any) => a.sortOrder - b.sortOrder)
          .map((p) => structuredClone(p))
        if (include.pages.include?.file) for (const p of pages) p.file = state.files[p.fileId]
        clone.pages = pages
      }
      return clone
    },
    findMany: async ({ where }: Any) => Object.values(state.docs).filter((d) => docMatches(d, where)),
    findFirst: async ({ where }: Any) =>
      Object.values(state.docs).filter((d) => docMatches(d, where)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0] ?? null,
  },
  labDocumentPage: {
    createMany: async ({ data }: Any) => {
      for (const p of data) state.pages.push({ id: nextId('pg'), ...p })
      return { count: data.length }
    },
  },
  labAlias: {
    findFirst: async () => null,
  },
  labProfile: {
    findUnique: async () => null,
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
  $transaction: async (fn: Any, _opts?: Any) => fn(tx),
}
const tx: Any = {
  labFile: {
    create: async ({ data }: Any) => {
      const rec = { ...data, purgedAt: null, pages: [], _pendingDoc: true }
      state.files[data.id] = rec
      state.fileOrder.push(rec)
      return rec
    },
  },
  labDocument: {
    create: async ({ data }: Any) => {
      const rec = freshDoc(nextId('doc'), {
        kind: data.kind,
        status: data.status,
        labId: data.labId ?? null,
        statementMonth: data.statementMonth ?? null,
        uploadedBy: data.uploadedBy,
      })
      state.docs[rec.id] = rec
      const pf = [...state.fileOrder].reverse().find((f) => f._pendingDoc)
      if (pf) {
        pf._pendingDoc = false
        pf.pages = [{ documentId: rec.id }]
      }
      return rec
    },
    update: fakes.labDocument.update,
  },
  labDocumentPage: fakes.labDocumentPage,
  labDocumentLine: fakes.labDocumentLine,
}

// ── env / 碟 ────────────────────────────────────────────────
let tmp = ''
const OLD_ENV: Record<string, string | undefined> = {}
const ENV_KEYS = ['LAB_DOC_DIR', 'LAB_DOC_ENC_KEY', 'LAB_DOC_ENC_KID', 'WA_INBOX_LABDOC_URL', 'INTERNAL_LLM_SECRET', 'INTERNAL_LLM_KID', 'LABDOC_RETRY_MS_MS']
const saved: [Any, string, Any][] = []

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'labdoc-route-test-'))
  for (const k of ENV_KEYS) OLD_ENV[k] = process.env[k]
  process.env.LAB_DOC_DIR = tmp
  process.env.LAB_DOC_ENC_KEY = randomBytes(32).toString('base64')
  process.env.LAB_DOC_ENC_KID = 'k1'
  process.env.WA_INBOX_LABDOC_URL = 'http://127.0.0.1:9/unused'
  process.env.INTERNAL_LLM_SECRET = randomBytes(32).toString('base64')
  process.env.INTERNAL_LLM_KID = 'k1'
  process.env.LABDOC_RETRY_MS_MS = '1'
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
  state = { seq: 0, users: {}, labs: {}, writeLogs: {}, files: {}, fileOrder: [], docs: {}, pages: [], lines: [], auditRows: [] }
  addUsers()
  state.labs = { labexcel0000000000000000001: { id: 'labexcel0000000000000000001', name: 'Excel', isActive: true } }
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
  __setLabDocExtractFn(null)
})

// ── 用戶 / token ────────────────────────────────────────────
function addUser(userId: string, role: string, extra: Any = {}) {
  state.users[userId] = {
    id: userId,
    name: '測試用戶',
    tokenVersion: 1,
    status: 'ACTIVE',
    ipAllowlist: null,
    permissionsJson: null,
    clinics: [{ clinicId: 'c1' }],
    ...extra,
  }
}
function addUsers() {
  addUser('u-owner-0000000000000000000', 'OWNER')
  addUser('u-emp-noperm00000000000000001', 'EMPLOYEE')
  addUser('u-emp-inv000000000000000002', 'EMPLOYEE', { permissionsJson: JSON.stringify({ grant: ['lab_invoice'] }) })
}
const token = (userId: string, role: string) => createToken({ userId, role: role as Any, clinics: ['c1'], tokenVersion: 1 })

function makeReq(url: string, tok: string | null, body?: Any): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body,
    headers: tok ? { cookie: `session=${tok}` } : undefined,
  })
}
function uploadForm(kind = 'INVOICE', key = 'key-1'): FormData {
  const f = new FormData()
  f.append('kind', kind)
  f.append('idempotencyKey', key)
  f.append('files', new File([PDF_BUF], 'sample-text.pdf', { type: 'application/pdf' }))
  f.append('splitPdfPages', 'false') // ★ P2 D9：預設拆頁；P1 測試行「全部一張」
  return f
}

const RUN_FAST: RunOpts = { retryDelayMs: 1, heartbeatMs: 25 }

// §5.4 測試結果：T18 核心字串
const T18_RESULT: Any = {
  kind: 'INVOICE',
  lab: { nameRaw: '禾呈大圍 040-543613-838', nameCnRaw: null, payeeRaw: null },
  billTo: { nameRaw: null, addressRaw: null, customerNoRaw: null, shortCodeRaw: null, doctorRaw: null },
  docNoRaw: 'INV-260805010',
  docNoLabel: 'Invoice No.',
  dateRaw: '2026-08-05',
  date: '2026-08-05',
  deliveryDate: null,
  orderReceivedDate: null,
  statementMonth: null,
  groups: [
    {
      patientNameRaw: null,
      patientCodeRaw: 'TW7159',
      labCaseRef: null,
      lines: [{ description: 'Crown', toothRaw: null, qty: 1, unitPrice: 500, listPrice: null, discountRaw: null, amount: 500 }],
    },
  ],
  sections: [],
  subtotal: 500,
  total: 500,
  readIssues: [],
}

describe('upload → 背景讀單（void hook，§5.1）', () => {
  it('401 無 token', async () => {
    const res = await uploadPOST(makeReq('http://localhost/api/lab-docs/upload', null, uploadForm()))
    assert.equal(res.status, 401)
  })

  it('T10 同型：EMPLOYEE 冇 lab_invoice → 403', async () => {
    const res = await uploadPOST(makeReq('http://localhost/api/lab-docs/upload', token('u-emp-noperm00000000000000001', 'EMPLOYEE'), uploadForm('INVOICE', 'key-403')))
    assert.equal(res.status, 403)
  })

  it('T18 route 級：上傳 201 立即回；背景讀單完 → nameRaw 刪＋token、docNo 保留、NEEDS_REVIEW', async () => {
    __setLabDocExtractFn(async () => ({ outcome: { result: structuredClone(T18_RESULT), reason: null }, nullReason: null }))
    const res = await uploadPOST(makeReq('http://localhost/api/lab-docs/upload', token('u-owner-0000000000000000000', 'OWNER'), uploadForm('INVOICE', 'key-t18')))
    assert.equal(res.status, 201)
    const body = (await res.json()) as Any
    assert.equal(body.documents.length, 1)
    assert.equal(body.documents[0].status, 'UPLOADED') // 回應時未讀完

    await __drainLabDocExtractions()
    const d = state.docs[body.documents[0].id]
    assert.equal(d.status, 'NEEDS_REVIEW')
    assert.equal(d.extractSource, 'TEXT')
    assert.equal(d.extractedJson.lab.nameRaw, null) // 敏感刪
    assert.equal(d.labNameRaw, null)
    assert.ok(d.readIssues.includes('SENSITIVE_REMOVED:lab.nameRaw'))
    assert.equal(d.docNo, 'INV-260805010') // F-03：單號保留（§6.4 正規化保留 hyphen）
    assert.equal(d.docNoKind, 'INVOICE_NO')
    assert.equal(d.total, 500)
    assert.equal(state.lines.length, 1)
  })

  it('LLM env 未設：上傳 201 照回（唔卡）→ 背景 3 次 → EXTRACT_FAILED not_configured', async () => {
    delete process.env.WA_INBOX_LABDOC_URL
    delete process.env.INTERNAL_LLM_SECRET
    try {
      const res = await uploadPOST(makeReq('http://localhost/api/lab-docs/upload', token('u-owner-0000000000000000000', 'OWNER'), uploadForm('INVOICE', 'key-nc')))
      assert.equal(res.status, 201)
      const body = (await res.json()) as Any
      await __drainLabDocExtractions()
      const d = state.docs[body.documents[0].id]
      assert.equal(d.status, 'EXTRACT_FAILED')
      assert.equal(d.extractError, 'not_configured')
      assert.equal(d.extractAttempts, 3)
    } finally {
      process.env.WA_INBOX_LABDOC_URL = 'http://127.0.0.1:9/unused'
      process.env.INTERNAL_LLM_SECRET = randomBytes(32).toString('base64')
    }
  })
})

describe('POST /api/lab-docs/:id/retry（§5.1／§11）', () => {
  async function seedFailedDoc(over: Partial<DocRow> = {}): Promise<string> {
    // 要真頁＋碟上加密原檔（runner buildPages 會解開抽文字層）
    const docId = nextId('doc')
    const fileId = nextId('file').slice(0, 25)
    const uploadedAt = new Date()
    await saveEncrypted(buildStorageKey(fileId, uploadedAt), PDF_BUF)
    for (let pageNo = 1; pageNo <= 2; pageNo++) {
      await saveEncrypted(buildPageKey(fileId, uploadedAt, pageNo, 'display'), Buffer.from(`display-${pageNo}`))
    }
    state.files[fileId] = {
      id: fileId,
      sha256: 'bb'.repeat(32),
      mime: 'application/pdf',
      sizeBytes: PDF_BUF.length,
      pageCount: 2,
      hasTextLayer: true,
      storageKey: buildStorageKey(fileId, uploadedAt),
      pagesJson: [
        { page: 1, displayKey: buildPageKey(fileId, uploadedAt, 1, 'display'), thumbKey: 't1', width: 100, height: 100, textChars: 50 },
        { page: 2, displayKey: buildPageKey(fileId, uploadedAt, 2, 'display'), thumbKey: 't2', width: 100, height: 100, textChars: 50 },
      ],
      uploadedAt,
      uploadedBy: 'u-test',
      purgedAt: null,
      pages: [],
    }
    for (let pageNo = 1; pageNo <= 2; pageNo++) {
      state.pages.push({ id: nextId('pg'), documentId: docId, fileId, pageNo, sortOrder: pageNo - 1 })
    }
    state.docs[docId] = freshDoc(docId, { status: 'EXTRACT_FAILED', extractAttempts: 3, extractError: 'timeout', ...over })
    return docId
  }
  const url = (id: string) => `http://localhost/api/lab-docs/${id}/retry`
  const call = (id: string, tok: string | null) => retryPOST(makeReq(url(id), tok) as any, { params: { id } } as any)

  it('401 無 token', async () => {
    const id = await seedFailedDoc()
    const res = await call(id, null)
    assert.equal(res.status, 401)
  })

  it('403 EMPLOYEE 冇 lab_invoice（RBAC_PERM_OVERRIDES 只 lab_invoice）', async () => {
    // stub 住背景讀單，避免 permission 放行嗰次走真 fetch（測試會掛起）
    __setLabDocExtractFn(async () => ({ outcome: { result: structuredClone(T18_RESULT), reason: null }, nullReason: null }))
    const id = await seedFailedDoc()
    const res = await call(id, token('u-emp-noperm00000000000000001', 'EMPLOYEE'))
    assert.equal(res.status, 403)
    const id2 = await seedFailedDoc()
    const res2 = await call(id2, token('u-emp-inv000000000000000002', 'EMPLOYEE'))
    assert.notEqual(res2.status, 403) // 有 lab_invoice → 放行（202）
    await __drainLabDocExtractions()
  })

  it('404 唔存在', async () => {
    const res = await call('docnonexistent000000000000001', token('u-owner-0000000000000000000', 'OWNER'))
    assert.equal(res.status, 404)
  })

  it('503 讀單服務未設定（§11：只喺「再讀」時回）', async () => {
    const id = await seedFailedDoc()
    delete process.env.WA_INBOX_LABDOC_URL
    try {
      const res = await call(id, token('u-owner-0000000000000000000', 'OWNER'))
      assert.equal(res.status, 503)
      const body = (await res.json()) as Any
      assert.match(body.error, /讀單服務未設定/)
    } finally {
      process.env.WA_INBOX_LABDOC_URL = 'http://127.0.0.1:9/unused'
    }
  })

  it('400 非 EXTRACT_FAILED 狀態', async () => {
    const id = await seedFailedDoc({ status: 'NEEDS_REVIEW' })
    const res = await call(id, token('u-owner-0000000000000000000', 'OWNER'))
    assert.equal(res.status, 400)
  })

  it('202 → 背景再讀成功（attempts 重置；NEEDS_REVIEW）', async () => {
    const id = await seedFailedDoc()
    __setLabDocExtractFn(async () => ({ outcome: { result: structuredClone(T18_RESULT), reason: null }, nullReason: null }))
    const res = await call(id, token('u-owner-0000000000000000000', 'OWNER'))
    assert.equal(res.status, 202)
    const body = (await res.json()) as Any
    assert.equal(body.status, 'EXTRACTING')
    await __drainLabDocExtractions()
    const d = state.docs[id]
    assert.equal(d.status, 'NEEDS_REVIEW')
    assert.equal(d.extractAttempts, 0) // claim 時重置
    assert.equal(d.extractError, null)
  })

  it('retry 失敗 3 次 → EXTRACT_FAILED（唔會無限）', async () => {
    const id = await seedFailedDoc()
    __setLabDocExtractFn(async () => ({ outcome: null, nullReason: 'timeout' }))
    const res = await call(id, token('u-owner-0000000000000000000', 'OWNER'))
    assert.equal(res.status, 202)
    await __drainLabDocExtractions()
    const d = state.docs[id]
    assert.equal(d.status, 'EXTRACT_FAILED')
    assert.equal(d.extractAttempts, 3)
    assert.equal(d.extractError, 'timeout')
  })
})

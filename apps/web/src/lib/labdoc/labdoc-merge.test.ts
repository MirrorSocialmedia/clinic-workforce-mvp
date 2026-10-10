/**
 * cwm-labdoc P2 §7.11 — POST /api/lab-docs/merge unit
 *
 * 覆蓋：
 *  - 201 happy path：新文件（頁按揀嘅次序、sortOrder 連號）＋舊文件 VOID（reason「合併到 {新 id}」）＋ audit
 *  - 守衛 400 家族：1 張 / 非 cuid / 重複 / STATEMENT / CONFIRMED / 唔同批次 / 唔同 Lab / 有 MATCHED 行（零寫入）
 *  - 404：有 id 唔存在
 *  - 409 race：tx 內源文件狀態被並发改（updateMany 0 行）→ 回滾
 *  - 冪等（T4）：同 key 同 hash → replay 200；唔新檔
 *  - auth：401 無 token / 403 EMPLOYEE
 *
 * ⚠ runLabDocExtract 防炸：route fire-and-forget 叫 extract — fake labDocument.updateMany
 *   對 claim 形（data.status='EXTRACTING'）一律回 0 行 → 'skipped'，唔跑背景 pipeline。
 */
import assert from 'node:assert'
import { test, before, after } from 'node:test'
import { NextRequest } from 'next/server'
import { createRequire } from 'node:module'

const req2 = createRequire(import.meta.url)
const jwt: any = req2('jsonwebtoken')

const OWNER = 'f'.repeat(25)
const D1 = 'a'.repeat(25)
const D2 = 'b'.repeat(25)
const D3 = 'c'.repeat(25)
const CLINIC_1 = 'k'.repeat(25)

process.env.JWT_SECRET = process.env.JWT_SECRET || 'p2-labdoc-merge-test-secret-012345'

function tokenFor(role: 'OWNER' | 'EMPLOYEE' = 'OWNER'): string {
  return jwt.sign({ userId: OWNER, role, clinics: [], tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })
}

interface DocState {
  id: string
  kind: string
  status: string
  clinicId: string | null
  labId: string | null
  docNo: string | null
  createdAt: Date
  uploadedBy: string
  voidReason: string | null
  voidedBy: string | null
  voidedAt: Date | null
}
interface PageState {
  id: string
  documentId: string
  fileId: string
  pageNo: number
  sortOrder: number
}
interface State {
  docs: Record<string, DocState>
  pages: PageState[]
  lines: Array<{ documentId: string; status: string }>
  audits: any[]
  writeLog: Map<string, any>
  forceRaceDocId: string | null
  createdCount: number
}

function mkDoc(id: string, over: Partial<DocState> = {}): DocState {
  return {
    id,
    kind: 'INVOICE',
    status: 'UPLOADED',
    clinicId: CLINIC_1,
    labId: null,
    docNo: `INV-${id.slice(0, 4)}`,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    uploadedBy: OWNER,
    voidReason: null,
    voidedBy: null,
    voidedAt: null,
    ...over,
  }
}

function makeFake(state: State) {
  const doc = (id: string): DocState | null => (state.docs[id] ? { ...state.docs[id] } : null)
  const fake: any = {
    user: {
      findUnique: async ({ where, select }: any) =>
        where.id === OWNER
          ? select
            ? { tokenVersion: 0, status: 'ACTIVE', clinics: [], permissionsJson: null }
            : { id: OWNER, name: 'Boss', role: 'OWNER', status: 'ACTIVE', tokenVersion: 0, ipAllowlist: null, clinics: [] }
          : null,
    },
    labDocument: {
      findMany: async ({ where }: any) => (where.id?.in ?? []).map(doc).filter(Boolean),
      findUnique: async ({ where }: any) => doc(where.id),
      create: async ({ data }: any) => {
        const id = `n${state.createdCount}`.padEnd(25, '0')
        state.createdCount++
        const row = mkDoc(id, { ...data, createdAt: new Date() })
        state.docs[id] = row
        return row
      },
      updateMany: async ({ where, data }: any) => {
        const d = state.docs[where.id]
        if (!d) return { count: 0 }
        if (data.status === 'EXTRACTING') return { count: 0 } // 唔 claim — 防背景 pipeline 跑
        if (where.status?.in && !where.status.in.includes(d.status)) return { count: 0 }
        if (state.forceRaceDocId === where.id) return { count: 0 }
        Object.assign(d, data)
        return { count: 1 }
      },
    },
    labDocumentPage: {
      findMany: async ({ where }: any) =>
        state.pages
          .filter((p) => p.documentId === where.documentId)
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((p) => ({ ...p })),
      create: async ({ data }: any) => {
        const row = { id: `pg${state.pages.length}`, ...data }
        state.pages.push(row)
        return row
      },
    },
    labDocumentLine: {
      count: async ({ where }: any) =>
        state.lines.filter((l) => (where.documentId?.in ? where.documentId.in.includes(l.documentId) : true) && (where.status ? l.status === where.status : true)).length,
    },
    auditLog: { create: async (a: any) => state.audits.push(a.data) },
    labDocWriteLog: {
      findUnique: async ({ where }: any) => state.writeLog.get(where.idempotencyKey) ?? null,
      create: async ({ data }: any) => {
        const row = { ...data, responseJson: null, createdAt: new Date() }
        state.writeLog.set(data.idempotencyKey, row)
        return row
      },
      update: async ({ where, data }: any) => {
        const row = state.writeLog.get(where.idempotencyKey)
        if (row) Object.assign(row, data)
        return row
      },
    },
    $transaction: async (fn: any) => {
      const snap = JSON.stringify({ docs: state.docs, pages: state.pages, audits: state.audits, createdCount: state.createdCount })
      try {
        return await fn(fake)
      } catch (e) {
        const back = JSON.parse(snap)
        state.docs = back.docs
        state.pages = back.pages
        state.audits = back.audits
        state.createdCount = back.createdCount
        throw e
      }
    },
  }
  return fake
}

import { prisma } from '../prisma'

const KEYS = ['user', 'labDocument', 'labDocumentPage', 'labDocumentLine', 'auditLog', 'labDocWriteLog', '$transaction'] as const
const saved: Record<string, unknown> = {}
for (const k of KEYS) saved[k] = (prisma as any)[k]
after(() => {
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
})

let POST: any
before(async () => {
  const mod: any = await import('../../app/api/lab-docs/merge/route')
  POST = mod.POST
})

function reset(state: State) {
  const fake = makeFake(state)
  for (const k of KEYS) Object.defineProperty(prisma, k, { value: fake[k], configurable: true, writable: true })
}

function baseState(over: Partial<State> = {}): State {
  return {
    docs: { [D1]: mkDoc(D1), [D2]: mkDoc(D2) },
    pages: [
      { id: 'pg1', documentId: D1, fileId: 'file1', pageNo: 1, sortOrder: 0 },
      { id: 'pg2', documentId: D1, fileId: 'file1', pageNo: 2, sortOrder: 1 },
      { id: 'pg3', documentId: D2, fileId: 'file2', pageNo: 1, sortOrder: 0 },
    ],
    lines: [],
    audits: [],
    writeLog: new Map(),
    forceRaceDocId: null,
    createdCount: 0,
    ...over,
  }
}

function mergeReq(body: unknown, role: 'OWNER' | 'EMPLOYEE' = 'OWNER', token?: string | null): NextRequest {
  // undefined = 用 tokenFor(role)；null = 無 cookie（401 測試用）
  const tok = token === null ? null : (token ?? tokenFor(role))
  return new NextRequest('http://x/api/lab-docs/merge', {
    method: 'POST',
    headers: {
      ...(tok ? { cookie: `session=${tok}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

const BASE_BODY = { idempotencyKey: 'merge-1', sourceDocIds: [D1, D2] }

test('201 happy path：新文件頁按次序＋舊文件 VOID（合併到 {新 id}）＋ audit', async () => {
  const state = baseState()
  reset(state)
  const r = await POST(mergeReq(BASE_BODY) as any, { params: Promise.resolve({}) } as any)
  const body = await r.json()
  const newId: string = body.document.id
  assert.notStrictEqual(newId, D1)
  assert.strictEqual(body.document.status, 'UPLOADED')
  assert.strictEqual(body.document.pageCount, 3)
  assert.deepStrictEqual(body.voidedDocIds, [D1, D2])
  // 新文件：3 頁、按揀嘅次序（D1 p1, D1 p2, D2 p1）、sortOrder 連號
  const newPages = state.pages.filter((p) => p.documentId === newId).sort((a, b) => a.sortOrder - b.sortOrder)
  assert.deepStrictEqual(newPages.map((p) => [p.fileId, p.pageNo]), [['file1', 1], ['file1', 2], ['file2', 1]])
  assert.deepStrictEqual(newPages.map((p) => p.sortOrder), [0, 1, 2])
  // 舊文件 VOID
  for (const id of [D1, D2]) {
    assert.strictEqual(state.docs[id].status, 'VOID')
    assert.strictEqual(state.docs[id].voidReason, `合併到 ${newId}`)
    assert.strictEqual(state.docs[id].voidedBy, OWNER)
    assert.ok(state.docs[id].voidedAt instanceof Date)
  }
  // audit（🔴 無病人資料）
  const a = state.audits.find((x) => x.action === 'LAB_DOC_MERGE')
  assert.ok(a)
  assert.strictEqual(a.entityId, newId)
  assert.doesNotMatch(JSON.stringify(a), /patient/i)
})

test('201：選 D2 先 D1 後 → 頁次序跟 selection（D2 頁喺前）', async () => {
  const state = baseState()
  reset(state)
  const r = await POST(mergeReq({ ...BASE_BODY, idempotencyKey: 'merge-ord', sourceDocIds: [D2, D1] }) as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r.status, 201)
  const newId: string = (await r.json()).document.id
  const newPages = state.pages.filter((p) => p.documentId === newId).sort((a, b) => a.sortOrder - b.sortOrder)
  assert.deepStrictEqual(newPages.map((p) => p.fileId), ['file2', 'file1', 'file1'])
})

test('守衛 400 家族（零寫入）：1 張 / 非 cuid / 重複 / STATEMENT / CONFIRMED / 唔同批次 / 唔同 Lab / 有 MATCHED 行', async () => {
  const cases: Array<[string, unknown, State]> = [
    ['1 張', { ...BASE_BODY, idempotencyKey: 'm-a', sourceDocIds: [D1] }, baseState()],
    ['非 cuid', { ...BASE_BODY, idempotencyKey: 'm-b', sourceDocIds: [D1, 'short'] }, baseState()],
    ['重複', { ...BASE_BODY, idempotencyKey: 'm-c', sourceDocIds: [D1, D1] }, baseState()],
    ['STATEMENT', { ...BASE_BODY, idempotencyKey: 'm-d' }, baseState({ docs: { [D1]: mkDoc(D1, { kind: 'STATEMENT' }), [D2]: mkDoc(D2) } })],
    ['CONFIRMED', { ...BASE_BODY, idempotencyKey: 'm-e' }, baseState({ docs: { [D1]: mkDoc(D1, { status: 'CONFIRMED' }), [D2]: mkDoc(D2) } })],
    ['唔同批次', { ...BASE_BODY, idempotencyKey: 'm-f' }, baseState({ docs: { [D1]: mkDoc(D1), [D2]: mkDoc(D2, { createdAt: new Date('2026-09-02T10:00:00Z') }) } })],
    ['唔同 Lab', { ...BASE_BODY, idempotencyKey: 'm-g' }, baseState({ docs: { [D1]: mkDoc(D1, { labId: 'l'.repeat(25) }), [D2]: mkDoc(D2) } })],
    ['有 MATCHED 行', { ...BASE_BODY, idempotencyKey: 'm-h' }, baseState({ lines: [{ documentId: D2, status: 'MATCHED' }] })],
  ]
  for (const [label, body, st] of cases) {
    reset(st)
    const beforeDocs = Object.keys(st.docs).length
    const r = await POST(mergeReq(body) as any, { params: Promise.resolve({}) } as any)
    assert.strictEqual(r.status, 400, `${label}: 預期 400，得 ${r.status} ${JSON.stringify(await r.json())}`)
    assert.strictEqual(Object.keys(st.docs).length, beforeDocs, `${label}: 唔應該有新文件`)
    assert.strictEqual(st.createdCount, 0, `${label}: 零寫入`)
  }
})

test('404：有 id 唔存在（零寫入）', async () => {
  const state = baseState()
  reset(state)
  const r = await POST(mergeReq({ ...BASE_BODY, idempotencyKey: 'm-404', sourceDocIds: [D1, 'z'.repeat(25)] }) as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r.status, 404)
  assert.strictEqual(state.createdCount, 0)
})

test('409 race：tx 內源文件狀態被並发改（updateMany 0 行）→ 回滾（新文件／VOID 全部冇）', async () => {
  const state = baseState({ forceRaceDocId: D2 })
  reset(state)
  const r = await POST(mergeReq(BASE_BODY) as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r.status, 409)
  // 回滾：冇新文件、D1 都未 VOID、冇 audit
  assert.strictEqual(state.createdCount, 0)
  assert.strictEqual(state.docs[D1].status, 'UPLOADED')
  assert.strictEqual(state.docs[D2].status, 'UPLOADED')
  assert.strictEqual(state.audits.length, 0)
})

test('冪等（T4）：同 key 同 hash → replay 200＋replayed，唔新檔', async () => {
  const state = baseState()
  reset(state)
  const r1 = await POST(mergeReq(BASE_BODY) as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r1.status, 201)
  const createdAfterFirst = state.createdCount
  const r2 = await POST(mergeReq(BASE_BODY) as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r2.status, 200)
  const b2 = await r2.json()
  assert.strictEqual(b2.replayed, true)
  assert.strictEqual(state.createdCount, createdAfterFirst, 'replay 唔可以建新檔')
  // 同 key 唔同內容 → 409
  const r3 = await POST(mergeReq({ ...BASE_BODY, sourceDocIds: [D1] }) as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r3.status, 400, '1 張先掛 format 400（hash 檢查之前）')
})

test('auth：401 無 token；403 EMPLOYEE（lab_invoice 唔給）', async () => {
  const state = baseState()
  reset(state)
  const r1 = await POST(mergeReq(BASE_BODY, 'OWNER', null) as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r1.status, 401)
  const r2 = await POST(mergeReq(BASE_BODY, 'EMPLOYEE') as any, { params: Promise.resolve({}) } as any)
  assert.strictEqual(r2.status, 403)
  assert.strictEqual(state.createdCount, 0)
})

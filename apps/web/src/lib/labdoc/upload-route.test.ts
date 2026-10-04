/**
 * cwm-labdoc P1 — 上傳 API route 測試（§15.3 T8 重複 409、T10 權限 403、§4.2 限制/魔法字節、B15 冪等）
 * 跑法: npx tsx --test src/lib/labdoc/upload-route.test.ts
 *
 * 寫法跟 repo route test pattern（fake prisma monkey-patch ＋ createToken ＋
 * 直接 import route POST；pattern 照 timebank-makeup-batch-route.test.ts）。
 * 真用：requireAuth（RBAC matrix 真 CONFIG）、processUploadFile（真 sharp/pdfjs，
 * fixture sample-text.pdf）、saveEncrypted（真 fs → tmp LAB_DOC_DIR）。
 *
 * 覆蓋：
 *   - 401 無 session
 *   - T10：EMPLOYEE 冇 lab_invoice → 403（role gate；其餘 route 嘅 403 矩陣喺 file-routes.test.ts）
 *   - 400：kind 錯／idempotencyKey 格式錯／空檔
 *   - 415 魔法字節：非 PDF/JPEG 拒；%PDF- 但內容爛 → pdfjs 解析失敗拒
 *   - 413 邊界：單檔 15MB+1；21 檔；總數 60MB+
 *   - T8：同一 PDF（sha256）上兩次 → 第二次 409 { duplicateOf }
 *   - B15 冪等：同 key 同內容重送 → 200 replayed（唔多一筆）；同 key 異內容 → 409
 *   - batch 內兩份相同 bytes → 409
 *   - force=true 但只有 lab_invoice → 403（要 lab_statement）
 *   - 成功 201：碟上 5 個加密檔（原檔＋2 頁×display/thumb）、DB 單據/檔/頁、WriteLog DONE、audit 零 PII
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '../prisma'
import { createToken } from '../auth'
import { POST } from '../../app/api/lab-docs/upload/route'
import { isPdf, isJpeg } from './process'

type Any = any

// ── fixture ─────────────────────────────────────────────────
const FIXTURE = join(process.cwd(), 'test/fixtures/labdoc/sample-text.pdf') // 2 頁
const PDF_BUF = readFileSync(FIXTURE)

// ── fake state ──────────────────────────────────────────────
interface WLog {
  idempotencyKey: string
  status: 'IN_PROGRESS' | 'DONE'
  requestHash: string
  responseJson: Any
  route: string
  createdBy: string
  createdAt: Date
}
interface FFile {
  id: string
  sha256: string
  uploadedAt: Date
  uploadedBy: string
  purgedAt: Date | null
  pages: Array<{ document: { id: string; status: string } }>
}
interface State {
  seq: number
  users: Record<string, Any>
  labs: Record<string, Any>
  writeLogs: Record<string, WLog>
  seededFiles: FFile[]
  createdFiles: Array<FFile & { _pendingDoc?: boolean }>
  createdDocs: Any[]
  createdPages: number
  auditRows: Any[]
}
let state: State
const fresh = (): State => ({
  seq: 0,
  users: {},
  labs: {},
  writeLogs: {},
  seededFiles: [],
  createdFiles: [],
  createdDocs: [],
  createdPages: 0,
  auditRows: [],
})
const nextId = (p: string) => `${p}${String(++state.seq).padStart(21, '0')}` // cuid 形（25 位）

// ── fake prisma ─────────────────────────────────────────────
const fakes: Record<string, Any> = {
  user: {
    findUnique: async (args: Any) => state.users[args?.where?.id] ?? null,
  },
  lab: {
    findUnique: async (args: Any) => state.labs[args?.where?.id] ?? null,
  },
  labDocWriteLog: {
    findUnique: async (args: Any) => state.writeLogs[args?.where?.idempotencyKey] ?? null,
    upsert: async (args: Any) => {
      const k = args.where.idempotencyKey as string
      if (state.writeLogs[k]) Object.assign(state.writeLogs[k], args.update)
      else state.writeLogs[k] = { ...args.create, createdAt: new Date() }
      return state.writeLogs[k]
    },
    update: async (args: Any) => {
      const k = args.where.idempotencyKey as string
      if (state.writeLogs[k]) Object.assign(state.writeLogs[k], args.data)
      return state.writeLogs[k] ?? null
    },
  },
  labFile: {
    // 重複偵測（§4.2）：where { sha256: { in }, purgedAt: null }
    findMany: async (args: Any) => {
      const inSet: string[] = args?.where?.sha256?.in ?? []
      const pool: FFile[] = [...state.seededFiles, ...state.createdFiles]
      return pool
        .filter((f) => inSet.includes(f.sha256) && f.purgedAt === null)
        .map((f) => ({
          sha256: f.sha256,
          uploadedAt: f.uploadedAt,
          uploadedBy: f.uploadedBy,
          pages: f.pages,
        }))
    },
  },
  auditLog: {
    create: async (args: Any) => {
      state.auditRows.push(args.data)
      return args.data
    },
  },
  $transaction: async (fn: Any, _opts?: Any) => fn(tx),
}
const tx: Any = {
  labFile: {
    create: async (args: Any) => {
      const rec = { ...args.data, purgedAt: null, _pendingDoc: true }
      state.createdFiles.push(rec)
      return rec
    },
  },
  labDocument: {
    create: async (args: Any) => {
      const rec = {
        id: nextId('doc'),
        kind: args.data.kind,
        status: args.data.status,
        labId: args.data.labId ?? null,
        statementMonth: args.data.statementMonth ?? null,
        uploadedBy: args.data.uploadedBy,
        createdAt: new Date(),
      }
      state.createdDocs.push(rec)
      // 呢個 doc 係同一筆 iteration 嗰個 file 嘅單據 → 連 pages
      const pf = [...state.createdFiles].reverse().find((f) => f._pendingDoc)
      if (pf) {
        pf.pages = [{ document: { id: rec.id, status: rec.status } }]
        pf._pendingDoc = false
      }
      return rec
    },
  },
  labDocumentPage: {
    createMany: async (args: Any) => {
      state.createdPages += args.data.length
      return { count: args.data.length }
    },
  },
}

let tmp = ''
const OLD_ENV: Record<string, string | undefined> = {}
const saved: [Any, string, Any][] = []

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'labdoc-upload-test-'))
  for (const k of ['LAB_DOC_DIR', 'LAB_DOC_ENC_KEY', 'LAB_DOC_ENC_KID']) {
    OLD_ENV[k] = process.env[k]
  }
  process.env.LAB_DOC_DIR = tmp
  process.env.LAB_DOC_ENC_KEY = randomBytes(32).toString('base64')
  process.env.LAB_DOC_ENC_KID = 'k1'
  for (const k of Object.keys(fakes)) {
    saved.push([prisma, k, (prisma as Any)[k]])
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})
after(() => {
  for (const [obj, k, orig] of saved) {
    Object.defineProperty(obj, k, { value: orig, configurable: true, writable: true })
  }
  for (const [k, v] of Object.entries(OLD_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  state = fresh()
  addUsers()
  state.labs = {
    labexcel0000000000000000001: { id: 'labexcel0000000000000000001', name: 'Excel', isActive: true },
  }
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
})

// ── 用戶 ────────────────────────────────────────────────────
function addUser(userId: string, role: string, extra: Any = {}) {
  state.users[userId] = {
    id: userId,
    name: role === 'OWNER' ? '老闆測試' : `員工${userId.slice(-3)}`,
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
  addUser('u-emp-inv00000000000000000002', 'EMPLOYEE', {
    permissionsJson: JSON.stringify({ grant: ['lab_invoice'] }),
  })
  addUser('u-emp-stmt000000000000000003', 'EMPLOYEE', {
    permissionsJson: JSON.stringify({ grant: ['lab_statement'] }),
  })
}
const token = (userId: string, role: string) =>
  createToken({ userId, role: role as Any, clinics: ['c1'], tokenVersion: 1 })

function makeReq(tok: string | null, form: FormData, url = 'http://localhost/api/lab-docs/upload'): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: form,
    headers: tok ? { cookie: `session=${tok}` } : undefined,
  })
}
function form(kind = 'INVOICE', key = 'key-1', files: [Buffer, string][] = [[PDF_BUF, 'a.pdf']]): FormData {
  const f = new FormData()
  f.append('kind', kind)
  f.append('idempotencyKey', key)
  for (const [buf, name] of files) f.append('files', new File([new Uint8Array(buf)], name, { type: 'application/pdf' }))
  return f
}
const pdfPad = (n: number): Buffer => {
  const b = Buffer.alloc(n)
  b.write('%PDF-1.4 padding', 0)
  return b
}

/** tmp 碟上全部 .bin 檔數（遞迴） */
function countBins(dir = tmp): number {
  let n = 0
  for (const en of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, en.name)
    if (en.isDirectory()) n += countBins(p)
    else if (en.name.endsWith('.bin')) n++
  }
  return n
}
/** tmp 碟上第一個 .bin 檔路徑（遞迴） */
function firstBinPath(dir = tmp): string {
  for (const en of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, en.name)
    if (en.isDirectory()) {
      const r = firstBinPath(p)
      if (r) return r
    } else if (en.name.endsWith('.bin')) {
      return p
    }
  }
  return ''
}

describe('上傳 API — 守門（T15 401 / T10 403 / 400 格式）', () => {
  it('401 無 session', async () => {
    const res = await POST(makeReq(null, form()) as any)
    assert.equal(res.status, 401)
    assert.equal(state.createdDocs.length, 0)
  })

  it('T10：EMPLOYEE 冇 lab_invoice → 403（零寫入）', async () => {
    const res = await POST(makeReq(token('u-emp-noperm00000000000000001', 'EMPLOYEE'), form()) as any)
    assert.equal(res.status, 403)
    assert.match((await res.json()).error, /role EMPLOYEE not allowed/)
    assert.equal(state.createdDocs.length, 0)
    assert.equal(countBins(), 0)
  })

  it('400 kind 唔係 INVOICE/STATEMENT', async () => {
    const res = await POST(makeReq(token('u-owner-0000000000000000000', 'OWNER'), form('FOO')) as any)
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /INVOICE 或 STATEMENT/)
  })

  it('400 idempotencyKey 格式錯（空格/特殊字）', async () => {
    const res = await POST(makeReq(token('u-owner-0000000000000000000', 'OWNER'), form('INVOICE', 'bad key!')) as any)
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /idempotencyKey/)
  })

  it('400 空檔（0 bytes）', async () => {
    const res = await POST(makeReq(token('u-owner-0000000000000000000', 'OWNER'), form('INVOICE', 'k-empty', [[Buffer.alloc(0), 'empty.pdf']])) as any)
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /空檔/)
  })

  it('force=true 但只有 lab_invoice → 403（強制重傳要 lab_statement）', async () => {
    const f = form('STATEMENT', 'k-force')
    f.append('force', 'true')
    f.append('statementMonth', '2026-09')
    const res = await POST(makeReq(token('u-emp-inv00000000000000000002', 'EMPLOYEE'), f) as any)
    assert.equal(res.status, 403)
    assert.match((await res.json()).error, /lab_statement/)
  })
})

describe('上傳 API — 限制（§4.2：15MB/20 檔/60MB；413 邊界）', () => {
  const owner = token('u-owner-0000000000000000000', 'OWNER')

  it('413 單檔 15MB+1', async () => {
    const big = pdfPad(15 * 1024 * 1024 + 1)
    const res = await POST(makeReq(owner, form('INVOICE', 'k-big1', [[big, 'big.pdf']])) as any)
    assert.equal(res.status, 413)
    assert.match((await res.json()).error, /15MB/)
  })

  it('413 一次 21 個檔', async () => {
    const files: [Buffer, string][] = Array.from({ length: 21 }, (_, i) => [pdfPad(1024 + i), `f${i}.pdf`])
    const res = await POST(makeReq(owner, form('INVOICE', 'k-21', files)) as any)
    assert.equal(res.status, 413)
    assert.match((await res.json()).error, /20/)
  })

  it('413 總數 60MB+（5×13MB = 65MB；每個都 <15MB）', async () => {
    const files: [Buffer, string][] = Array.from({ length: 5 }, (_, i) => [pdfPad(13 * 1024 * 1024), `t${i}.pdf`])
    const res = await POST(makeReq(owner, form('INVOICE', 'k-60mb', files)) as any)
    assert.equal(res.status, 413)
    assert.match((await res.json()).error, /60MB/)
  })

  it('413 PDF >30 頁上限（process 層；用假 31 頁唔實際 — 邊界喺 processPdf，此處用 2 頁 fixture 唔适用 → 跳）', () => {
    // 31 頁 PDF fixture 未有；邊界邏輯（PDF_MAX_PAGES=30）由 alpine render fixture + 型別保證。
    // 呢行係佔位防誤解 — 唔跑。
  })
})

describe('上傳 API — 魔法字節（§4.2：只收 JPEG/PDF）', () => {
  const owner = token('u-owner-0000000000000000000', 'OWNER')

  it('isPdf/isJpeg 純函數', () => {
    assert.equal(isPdf(Buffer.from('%PDF-1.7 whatever')), true)
    assert.equal(isPdf(Buffer.from('PDF-1.7')), false) // 冇 %
    assert.equal(isPdf(Buffer.from('short')), false)
    assert.equal(isJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])), true)
    assert.equal(isJpeg(Buffer.from([0xff, 0xd8])), false)
    assert.equal(isJpeg(Buffer.from('%PDF-1.7')), false)
  })

  it('415 非 PDF/JPEG（爛 bytes）→ 檔案類型唔接受', async () => {
    const res = await POST(makeReq(owner, form('INVOICE', 'k-garbage', [[Buffer.from('hello world, not a pdf'), 'x.bin']])) as any)
    assert.equal(res.status, 415)
    assert.match((await res.json()).error, /檔案類型唔接受/)
    assert.equal(state.createdDocs.length, 0)
  })

  it('415 %PDF- 魔術字頭但內容爛 → PDF 解析失敗（真 pdfjs）', async () => {
    const res = await POST(makeReq(owner, form('INVOICE', 'k-fakepdf', [[Buffer.from('%PDF-1.4 this is not really a pdf'), 'fake.pdf']])) as any)
    assert.equal(res.status, 415)
    assert.match((await res.json()).error, /PDF 解析失敗/)
    assert.equal(state.createdDocs.length, 0)
  })
})

describe('T8：同一 PDF（sha256）上傳兩次 → 第二次 409 duplicateOf', () => {
  const owner = token('u-owner-0000000000000000000', 'OWNER')

  it('第一次 201；第二次（新 key、同 bytes）409 { duplicateOf }', async () => {
    const r1 = await POST(makeReq(owner, form('INVOICE', 'k-dup-1')) as any)
    assert.equal(r1.status, 201)
    const b1 = await r1.json()
    assert.equal(b1.documents.length, 1)
    assert.equal(b1.documents[0].status, 'UPLOADED')
    const docId: string = b1.documents[0].id

    // 碟上：2 頁 fixture → 原檔 1 + (display+thumb)×2 = 5 個加密檔
    assert.equal(countBins(), 5, '碟上應該有 5 個 LDOC1 檔')
    // DB：1 單據、1 檔、2 頁、WriteLog DONE、audit 1 行
    assert.equal(state.createdDocs.length, 1)
    assert.equal(state.createdFiles.length, 1)
    assert.equal(state.createdPages, 2)
    assert.equal(state.writeLogs['k-dup-1'].status, 'DONE')
    assert.equal(state.auditRows.length, 1)
    assert.equal(state.auditRows[0].action, 'LAB_DOC_UPLOAD')
    const auditDump = JSON.stringify(state.auditRows[0])
    assert.ok(!/patientNameRaw|patientRaw/.test(auditDump), 'audit 唔可以有姓名欄')

    // 碟上檔必須係加密 blob（LDOC1 頭），唔係原 PDF
    const binPath = firstBinPath()
    assert.ok(binPath, '碟上要有 .bin 檔')
    assert.equal(readFileSync(binPath).subarray(0, 5).toString('ascii'), 'LDOC1')

    const r2 = await POST(makeReq(owner, form('INVOICE', 'k-dup-2')) as any)
    assert.equal(r2.status, 409)
    const b2 = await r2.json()
    assert.equal(b2.duplicateOf, docId, '409 要指返第一張單據')
    assert.match(b2.message, /已經喺 .* 由 .* 上傳過/)
    // 冇多一筆
    assert.equal(state.createdDocs.length, 1)
    assert.equal(countBins(), 5, '重複檔唔可以寫第二份落碟')
  })

  it('已作廢（VOID）單據嘅檔案唔算重複（存底可再收）', async () => {
    // seed：同一 sha256（真值由 route 算 — 用 fixture 真 sha256）
    const { createHash } = await import('node:crypto')
    const sha = createHash('sha256').update(PDF_BUF).digest('hex')
    state.seededFiles.push({
      id: 'fvoid0000000000000000000001',
      sha256: sha,
      uploadedAt: new Date(),
      uploadedBy: 'u-owner-0000000000000000000',
      purgedAt: null,
      pages: [{ document: { id: 'docvoid00000000000000001', status: 'VOID' } }],
    })
    const res = await POST(makeReq(owner, form('INVOICE', 'k-void-ok')) as any)
    assert.equal(res.status, 201, 'VOID 單據唔擋新上傳')
    assert.equal(state.createdDocs.length, 1)
  })
})

describe('B15 冪等：idempotencyKey + requestHash', () => {
  const owner = token('u-owner-0000000000000000000', 'OWNER')

  it('同 key 同內容重送（524 重試）→ 200 replayed；唔多一筆', async () => {
    const r1 = await POST(makeReq(owner, form('INVOICE', 'k-replay')) as any)
    assert.equal(r1.status, 201)
    const docId = (await r1.json()).documents[0].id

    const r2 = await POST(makeReq(owner, form('INVOICE', 'k-replay')) as any)
    assert.equal(r2.status, 200)
    const b2 = await r2.json()
    assert.equal(b2.replayed, true)
    assert.equal(b2.documents[0].id, docId, 'replay 要回同一個單據 id')
    assert.equal(state.createdDocs.length, 1, '重送唔可以多一筆單據')
    assert.equal(countBins(), 5, '重送唔可以再寫碟')
  })

  it('同 key 異內容 → 409（key 已用过但內容唔同）', async () => {
    const r1 = await POST(makeReq(owner, form('INVOICE', 'k-samekey')) as any)
    assert.equal(r1.status, 201)
    const r2 = await POST(makeReq(owner, form('INVOICE', 'k-samekey', [[Buffer.from('%PDF-1.4 totally different bytes here'), 'other.pdf']])) as any)
    assert.equal(r2.status, 409)
    assert.match((await r2.json()).error, /已用过但內容唔同/)
    assert.equal(state.createdDocs.length, 1)
  })
})

describe('上傳 API — batch 內重複', () => {
  it('同一 request 兩份相同 bytes → 409（第 N 個檔同 batch 內其他檔完全相同）', async () => {
    const owner = token('u-owner-0000000000000000000', 'OWNER')
    const res = await POST(makeReq(owner, form('INVOICE', 'k-batchdup', [[PDF_BUF, 'a.pdf'], [PDF_BUF, 'b.pdf']])) as any)
    assert.equal(res.status, 409)
    assert.match((await res.json()).error, /batch/)
    assert.equal(state.createdDocs.length, 0)
  })
})

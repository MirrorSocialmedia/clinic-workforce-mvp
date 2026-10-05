/**
 * cwm-labdoc P1 — 檔案庫讀 API + purge route 測試（§15.3 T15 檔案 route 401/403/410/no-store、T10 403 矩陣、T16 x-cron-now chain）
 * 跑法: npx tsx --test src/lib/labdoc/file-routes.test.ts
 *
 * 寫法跟 repo route test pattern（fake prisma monkey-patch ＋ createToken ＋
 * 直接 import route handler；pattern 照 timebank-makeup-batch-route.test.ts）。
 * 真用：requireAuth（RBAC 真 CONFIG）、readEncrypted（真 fs → tmp LAB_DOC_DIR）、
 * runLabDocPurge（internal route 全 chain，fake prisma ＋ 真碟）。
 *
 * 覆蓋：
 *   - T15 未登入 401（pages／original）
 *   - T10 EMPLOYEE 冇 lab_invoice call 每條 labdoc route → 403（5 條）＋ 有權 perm 放行對照
 *   - 400：fileId 格式／頁碼 0 同 31／非整數／v 非法
 *   - 404：檔唔存在／無主檔（0 頁）／頁唔喺 pagesJson
 *   - T15 已 purge → 410（body：原檔已按保留政策（7 年）於 {HK 日期} 刪除）
 *   - T15 200：Cache-Control: private, no-store ＋ nosniff（pages jpeg magic／original 逐 byte）
 *   - LAB_DOC_FILE_DOWNLOAD audit（fileId only、零姓名）
 *   - internal purge 守門：key 未設 503／冇 key 403／錯 key 403／壞 x-cron-now 400
 *   - T16 chain（gen8 手法）：x-cron-now 造到期 → POST purge → 200 統計 → 同一檔 GET → 410
 *     ＋ PII 清姓名保留金額（chain 層斷言；purge 內涵細節喺 purge.test.ts 9 項）
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { NextRequest } from 'next/server'
import { prisma } from '../prisma'
import { createToken } from '../auth'
import { saveEncrypted } from './storage'
import { POST as POST_PURGE } from '../../app/api/internal/labdoc-purge/route'
import { GET as GET_PAGE } from '../../app/api/lab-docs/files/[fileId]/pages/[n]/route'
import { GET as GET_ORIG } from '../../app/api/lab-docs/files/[fileId]/original/route'
import { GET as GET_LIST } from '../../app/api/lab-docs/route'
import { GET as GET_DETAIL } from '../../app/api/lab-docs/[id]/route'
import { POST as POST_UPLOAD } from '../../app/api/lab-docs/upload/route'

type Any = any

const F0 = 'f000000000000000000000000' // 25 位 — 活躍檔（未 purge），屬於 D0
const F1 = 'f111111111111111111111111' // 25 位 — chain test 嘅到期檔，屬於 D1
const F2 = 'f222222222222222222222222' // 25 位 — 已 purged 檔
const D0 = 'd000000000000000000000000'
const D1 = 'd111111111111111111111111'
const CRON_KEY = 'test-cron-key-labdoc-123'
const CRON_NOW = '2026-10-05T03:30:00.000Z' // = HK 2026-10-05 11:30

// ── fake state ──────────────────────────────────────────────
interface FFile {
  id: string
  storageKey: string
  pagesJson: Any
  purgeAt: Date
  purgedAt: Date | null
  mime: string
  pages: Array<{ documentId: string }>
}
interface FDoc { id: string; clinicId: string | null; extractedJson: Any }
interface FLine { id: string; documentId: string; patientNameRaw: string | null; amount: number }
interface State {
  users: Record<string, Any>
  files: Record<string, FFile>
  docs: Record<string, FDoc>
  lines: FLine[]
  statementTable: boolean
  auditRows: Any[]
}
let state: State
const fresh = (): State => ({
  users: {},
  files: {},
  docs: {},
  lines: [],
  statementTable: false,
  auditRows: [],
})

function seedFile(id: string, key: string, opts: Partial<FFile> = {}): void {
  state.files[id] = {
    id,
    storageKey: key,
    pagesJson: [{ page: 1, displayKey: `${key.replace(/\.bin$/, '')}.p1.jpg.bin`, thumbKey: `${key.replace(/\.bin$/, '')}.p1.thumb.jpg.bin` }],
    purgeAt: new Date('2033-10-05T00:00:00Z'), // 預設未到期（7 年後）
    purgedAt: null,
    mime: 'application/pdf',
    pages: [{ documentId: D0 }],
    ...opts,
  }
}

// ── fake prisma ─────────────────────────────────────────────
const fakes: Record<string, Any> = {
  user: {
    findUnique: async (args: Any) => state.users[args?.where?.id] ?? null,
  },
  labFile: {
    findUnique: async (args: Any) => {
      const f = state.files[args?.where?.id]
      return f ? { ...f, pages: f.pages } : null
    },
    // 雙用途：(a) purge step1 due list（where.purgeAt.lte）(b) sweep loadDbStorageKeys（select 冇 id）
    findMany: async (args: Any) => {
      const all = Object.values(state.files)
      if (args?.select && args.select.id === undefined) {
        return all.map((f) => ({ storageKey: f.storageKey, pagesJson: f.pagesJson }))
      }
      const lte = args?.where?.purgeAt?.lte as Date | undefined
      if (lte) {
        return all
          .filter((f) => f.purgedAt === null && f.purgeAt.getTime() <= lte.getTime())
          .map((f) => ({ id: f.id, storageKey: f.storageKey, pagesJson: f.pagesJson }))
      }
      return []
    },
    updateMany: async (args: Any) => {
      const f = state.files[args.where.id]
      if (f && args.where.purgedAt === null && f.purgedAt === null) {
        f.purgedAt = new Date(args.data.purgedAt.getTime())
        return { count: 1 }
      }
      return { count: 0 }
    },
  },
  labDocument: {
    findUnique: async (args: Any) => {
      const d = state.docs[args?.where?.id]
      return d ? { id: d.id, extractedJson: d.extractedJson } : null
    },
    // 雙用途：(a) scope 檢查（where.id.in ＋ clinicId.in）(b) purge step2（where.AND some/every）
    findMany: async (args: Any) => {
      if (args?.where?.AND) {
        return Object.values(state.docs)
          .filter((d) => {
            const pp = Object.values(state.files).filter((f) => f.pages.some((p) => p.documentId === d.id))
            if (pp.length === 0) return false
            return pp.some((f) => f.purgedAt !== null) && pp.every((f) => f.purgedAt !== null)
          })
          .map((d) => ({ id: d.id, clinicId: d.clinicId }))
      }
      const inIds: string[] = args?.where?.id?.in ?? []
      const inClinics: string[] | null = args?.where?.clinicId?.in ?? null
      return Object.values(state.docs)
        .filter((d) => (inIds.length ? inIds.includes(d.id) : true))
        .filter((d) => (inClinics ? d.clinicId && inClinics.includes(d.clinicId) : true))
        .map((d) => ({ id: d.id, clinicId: d.clinicId }))
    },
    count: async (args: Any) => {
      const inIds: string[] = args?.where?.id?.in ?? []
      const inClinics: string[] | null = args?.where?.clinicId?.in ?? null
      return Object.values(state.docs)
        .filter((d) => (inIds.length ? inIds.includes(d.id) : true))
        .filter((d) => (inClinics ? d.clinicId && inClinics.includes(d.clinicId) : true)).length
    },
    update: async (args: Any) => {
      const d = state.docs[args.where.id]
      if (d) Object.assign(d, args.data)
      return d ?? null
    },
  },
  labDocumentLine: {
    updateMany: async (args: Any) => {
      let n = 0
      for (const l of state.lines) {
        if (l.documentId === args.where.documentId && args.where.patientNameRaw?.not === null && l.patientNameRaw !== null) {
          l.patientNameRaw = null
          n++
        }
      }
      return { count: n }
    },
  },
  auditLog: {
    create: async (args: Any) => {
      state.auditRows.push(args.data)
      return args.data
    },
  },
  $transaction: async (fn: Any, _opts?: Any) => fn(tx),
  $queryRaw: async () => [{ exists: state.statementTable }],
  $executeRaw: async () => 0,
}
const tx: Any = {
  labDocument: fakes.labDocument,
  labDocumentLine: fakes.labDocumentLine,
  $queryRaw: fakes.$queryRaw,
  $executeRaw: fakes.$executeRaw,
}

let tmp = ''
let F0_ORIGINAL: Buffer
const OLD_ENV: Record<string, string | undefined> = {}
const saved: [Any, string, Any][] = []

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'labdoc-fileroutes-test-'))
  for (const k of ['LAB_DOC_DIR', 'LAB_DOC_ENC_KEY', 'LAB_DOC_ENC_KID', 'APRICOT_CRON_KEY']) {
    OLD_ENV[k] = process.env[k]
  }
  process.env.LAB_DOC_DIR = tmp
  process.env.LAB_DOC_ENC_KEY = randomBytes(32).toString('base64')
  process.env.LAB_DOC_ENC_KID = 'k1'
  process.env.APRICOT_CRON_KEY = CRON_KEY
  for (const k of Object.keys(fakes)) {
    saved.push([prisma, k, (prisma as Any)[k]])
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
  // F0：活躍檔（真加密落碟 — 每 test state 重建但碟上 bytes 唔變）
  const key = '2026/10/' + F0 + '.bin'
  F0_ORIGINAL = Buffer.from('%PDF-1.7 fake-original-bytes-for-test-' + randomBytes(8).toString('hex'))
  await saveEncrypted(key, F0_ORIGINAL)
  await saveEncrypted(`${key.replace(/\.bin$/, '')}.p1.jpg.bin`, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]))
  await saveEncrypted(`${key.replace(/\.bin$/, '')}.p1.thumb.jpg.bin`, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 5, 6, 7, 8]))
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
  state.users = {
    'u-owner-0000000000000000000': { id: 'u-owner-0000000000000000000', name: '老闆測試', tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null, clinics: [{ clinicId: 'c1' }] },
    'u-emp-noperm00000000000000001': { id: 'u-emp-noperm00000000000000001', name: '無權員工', tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null, clinics: [{ clinicId: 'c1' }] },
    'u-emp-inv00000000000000000002': { id: 'u-emp-inv00000000000000000002', name: '有權員工', tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: JSON.stringify({ grant: ['lab_invoice'] }), clinics: [{ clinicId: 'c1' }] },
  }
  seedFile(F0, '2026/10/' + F0 + '.bin') // 屬於 D0
  state.docs[D0] = { id: D0, clinicId: 'c1', extractedJson: null }
  state.lines = []
})

const token = (userId: string, role: string) =>
  createToken({ userId, role: role as Any, clinics: ['c1'], tokenVersion: 1 })

const req = (tok: string | null, url: string, method = 'GET', headers: Record<string, string> = {}): NextRequest =>
  new NextRequest(url, {
    method,
    headers: {
      ...(tok ? { cookie: `session=${tok}` } : {}),
      ...headers,
    },
  })

const OWNER = 'u-owner-0000000000000000000'
const NOPE = 'u-emp-noperm00000000000000001'
const INV = 'u-emp-inv00000000000000000002'

describe('T15 檔案 route — 401 未登入', () => {
  it('pages 401', async () => {
    const res = await GET_PAGE(req(null, `http://localhost/api/lab-docs/files/${F0}/pages/1`) as any, { params: { fileId: F0, n: '1' } })
    assert.equal(res.status, 401)
  })
  it('original 401', async () => {
    const res = await GET_ORIG(req(null, `http://localhost/api/lab-docs/files/${F0}/original`) as any, { params: { fileId: F0 } })
    assert.equal(res.status, 401)
  })
})

describe('T10 EMPLOYEE 冇 lab_invoice — 每條 labdoc route 403', () => {
  const tok = token(NOPE, 'EMPLOYEE')
  it('POST /api/lab-docs/upload → 403', async () => {
    const form = new FormData()
    form.append('kind', 'INVOICE')
    form.append('idempotencyKey', 'k-matrix')
    form.append('files', new File([Buffer.from('x')], 'x.pdf'))
    const res = await POST_UPLOAD(req(tok, 'http://localhost/api/lab-docs/upload', 'POST', { 'content-type': 'multipart/form-data; boundary=x' }) as any)
    assert.equal(res.status, 403)
  })
  it('GET /api/lab-docs → 403', async () => {
    const res = await GET_LIST(req(tok, 'http://localhost/api/lab-docs') as any)
    assert.equal(res.status, 403)
  })
  it('GET /api/lab-docs/:id → 403', async () => {
    const res = await GET_DETAIL(req(tok, `http://localhost/api/lab-docs/${D1}`) as any, { params: { id: D1 } })
    assert.equal(res.status, 403)
  })
  it('GET files/:id/pages/:n → 403', async () => {
    const res = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/${F0}/pages/1`) as any, { params: { fileId: F0, n: '1' } })
    assert.equal(res.status, 403)
  })
  it('GET files/:id/original → 403', async () => {
    const res = await GET_ORIG(req(tok, `http://localhost/api/lab-docs/files/${F0}/original`) as any, { params: { fileId: F0 } })
    assert.equal(res.status, 403)
  })

  it('對照：EMPLOYEE 有 lab_invoice（perm 放行 B10）→ original 200', async () => {
    const res = await GET_ORIG(req(token(INV, 'EMPLOYEE'), `http://localhost/api/lab-docs/files/${F0}/original`) as any, { params: { fileId: F0 } })
    assert.equal(res.status, 200)
  })
})

describe('T15 檔案 route — 400 格式／404 邊界', () => {
  // 註：HTTP 層實戰上，唔合格 fileId／頁碼（0、31、非數字）已經被 RBAC matrix 擋咗
  // （normalizeRoute 只認 :id＋pages/1-30 → 「route not registered」403 — 見頭部註）。
  // handler 入面嘅 400 格式檢查係 defense-in-depth（params 同 URL 唔一致時先 reach 到）—
  // 以下用「matrix 合格 URL ＋ 唔合格 params」驗呢層 guard。
  const tok = token(OWNER, 'OWNER')
  it('pages：params fileId 格式錯（defense-in-depth）→ 400', async () => {
    const res = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/${F0}/pages/1`) as any, { params: { fileId: 'SHORT', n: '1' } })
    assert.equal(res.status, 400)
  })
  it('pages：params 頁碼 0／31／非整數／負數（defense-in-depth）→ 400', async () => {
    for (const n of ['0', '31', 'abc', '-1']) {
      const res = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/${F0}/pages/1`) as any, { params: { fileId: F0, n } })
      assert.equal(res.status, 400, `page ${n}`)
    }
  })
  it('pages：HTTP 層未登記頁碼（/pages/0）→ RBAC 403（route not registered）', async () => {
    const res = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/${F0}/pages/0`) as any, { params: { fileId: F0, n: '0' } })
    assert.equal(res.status, 403)
  })
  it('pages：v 非法 → 400', async () => {
    const res = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/${F0}/pages/1?v=full`) as any, { params: { fileId: F0, n: '1' } })
    assert.equal(res.status, 400)
  })
  it('original：params fileId 格式錯（defense-in-depth）→ 400', async () => {
    const res = await GET_ORIG(req(tok, `http://localhost/api/lab-docs/files/${F0}/original`) as any, { params: { fileId: 'SHORT' } })
    assert.equal(res.status, 400)
  })
  it('pages/original：檔唔存在 → 404', async () => {
    const r1 = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/f333333333333333333333333/pages/1`) as any, { params: { fileId: 'f333333333333333333333333', n: '1' } })
    assert.equal(r1.status, 404)
    const r2 = await GET_ORIG(req(tok, `http://localhost/api/lab-docs/files/f444444444444444444444444/original`) as any, { params: { fileId: 'f444444444444444444444444' } })
    assert.equal(r2.status, 404)
  })
  it('pages：無主檔（0 頁）→ 404', async () => {
    const F3 = 'f555555555555555555555555'
    seedFile(F3, '2026/10/' + F3 + '.bin', { pages: [] })
    const res = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/${F3}/pages/1`) as any, { params: { fileId: F3, n: '1' } })
    assert.equal(res.status, 404)
  })
  it('pages：頁唔喺 pagesJson（1 頁檔請 p2）→ 404', async () => {
    const res = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/${F0}/pages/2`) as any, { params: { fileId: F0, n: '2' } })
    assert.equal(res.status, 404)
  })
})

describe('T15 檔案 route — 200 ＋ Cache-Control: private, no-store（§4.3）', () => {
  const tok = token(OWNER, 'OWNER')

  it('pages 200：jpeg magic ＋ no-store ＋ nosniff', async () => {
    const res = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/${F0}/pages/1?v=display`) as any, { params: { fileId: F0, n: '1' } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/jpeg')
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    const body = Buffer.from(await res.arrayBuffer())
    assert.equal(body[0], 0xff)
    assert.equal(body[1], 0xd8)
    assert.equal(body[2], 0xff)
  })

  it('pages v=thumb 200（thumbKey 解到）', async () => {
    const res = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/${F0}/pages/1?v=thumb`) as any, { params: { fileId: F0, n: '1' } })
    assert.equal(res.status, 200)
  })

  it('original 200：逐 byte 相同 ＋ Content-Type ＋ no-store ＋ LAB_DOC_FILE_DOWNLOAD audit', async () => {
    const res = await GET_ORIG(req(tok, `http://localhost/api/lab-docs/files/${F0}/original`) as any, { params: { fileId: F0 } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'application/pdf')
    assert.equal(res.headers.get('cache-control'), 'private, no-store')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.match(res.headers.get('content-disposition') ?? '', /inline/)
    const body = Buffer.from(await res.arrayBuffer())
    assert.ok(body.equals(F0_ORIGINAL), '解密讀返必須同上傳原 bytes 逐 byte 相同')

    // §14：LAB_DOC_FILE_DOWNLOAD audit（fileId only、零姓名）
    const dl = state.auditRows.find((a) => a.action === 'LAB_DOC_FILE_DOWNLOAD')
    assert.ok(dl, '下載要有 audit 行')
    assert.equal(dl.entityId, F0)
    assert.equal(dl.actorId, OWNER)
    const dump = JSON.stringify(dl)
    assert.ok(!/patientNameRaw|patientRaw/.test(dump), 'download audit 零姓名')
  })
})

describe('T15 檔案 route — 已 purge 410', () => {
  const tok = token(OWNER, 'OWNER')
  const F2KEY = '2019/10/' + F2 + '.bin'

  it('purgedAt 已 set → pages 410（body 有保留政策＋HK 日期）', async () => {
    seedFile(F2, F2KEY, { purgedAt: new Date('2026-10-05T03:30:00Z'), pagesJson: [] })
    const res = await GET_PAGE(req(tok, `http://localhost/api/lab-docs/files/${F2}/pages/1`) as any, { params: { fileId: F2, n: '1' } })
    assert.equal(res.status, 410)
    const body = await res.json()
    assert.match(body.error, /原檔已按保留政策（7 年）於 2026-10-05 刪除/)
  })

  it('purgedAt 已 set → original 410', async () => {
    seedFile(F2, F2KEY, { purgedAt: new Date('2026-10-05T03:30:00Z') })
    const res = await GET_ORIG(req(tok, `http://localhost/api/lab-docs/files/${F2}/original`) as any, { params: { fileId: F2 } })
    assert.equal(res.status, 410)
    const body = await res.json()
    assert.match(body.error, /原檔已按保留政策（7 年）於 2026-10-05 刪除/)
  })
})

describe('internal /api/internal/labdoc-purge — 守門', () => {
  it('APRICOT_CRON_KEY 未設 → 503（fail closed）', async () => {
    delete process.env.APRICOT_CRON_KEY
    const res = await POST_PURGE(req(null, 'http://localhost/api/internal/labdoc-purge', 'POST', { 'x-cron-key': CRON_KEY }) as any)
    assert.equal(res.status, 503)
    process.env.APRICOT_CRON_KEY = CRON_KEY
  })
  it('冇 x-cron-key → 403', async () => {
    const res = await POST_PURGE(req(null, 'http://localhost/api/internal/labdoc-purge', 'POST') as any)
    assert.equal(res.status, 403)
  })
  it('錯 x-cron-key → 403', async () => {
    const res = await POST_PURGE(req(null, 'http://localhost/api/internal/labdoc-purge', 'POST', { 'x-cron-key': 'wrong-key' }) as any)
    assert.equal(res.status, 403)
  })
  it('壞 x-cron-now → 400（守門過咗先生效）', async () => {
    const res = await POST_PURGE(req(null, 'http://localhost/api/internal/labdoc-purge', 'POST', { 'x-cron-key': CRON_KEY, 'x-cron-now': 'not-a-date' }) as any)
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /x-cron-now/)
  })
})

describe('T16 chain（gen8 手法）：x-cron-now 造到期 → purge → 410 ＋ PII 清', () => {
  const F1KEY = '2019/10/' + F1 + '.bin'
  const F1_PJ = [
    { page: 1, displayKey: '2019/10/' + F1 + '.p1.jpg.bin', thumbKey: '2019/10/' + F1 + '.p1.thumb.jpg.bin' },
  ]

  async function seedDueFile(): Promise<void> {
    seedFile(F1, F1KEY, {
      pagesJson: F1_PJ,
      pages: [{ documentId: D1 }],
      purgeAt: new Date('2026-10-01T00:00:00Z'), // 已到期（< CRON_NOW）
    })
    state.docs[D1] = {
      id: D1,
      clinicId: 'c1',
      extractedJson: {
        labNameRaw: 'Excel',
        total: 1234.5,
        docNoRaw: 'INV-1',
        groups: [{ patientNameRaw: 'CHAN TEST A', amount: 900 }],
      },
    }
    state.lines = [{ id: 'line1', documentId: D1, patientNameRaw: 'CHAN TEST A', amount: 900 }]
    // 真加密檔落碟（3 個 key）
    await saveEncrypted(F1KEY, Buffer.from('%PDF-1.7 due-original'))
    await saveEncrypted(F1_PJ[0].displayKey, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
    await saveEncrypted(F1_PJ[0].thumbKey, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
  }

  it('到期 → purge 200（碟清空、purgedAt set、PII 清、金額留）→ 同檔 GET 410 → 重跑 no-op', async () => {
    await seedDueFile()
    assert.ok(existsSync(join(tmp, F1KEY)))

    const res = await POST_PURGE(
      req(null, 'http://localhost/api/internal/labdoc-purge', 'POST', { 'x-cron-key': CRON_KEY, 'x-cron-now': CRON_NOW }) as any,
    )
    assert.equal(res.status, 200)
    const out = await res.json()
    assert.equal(out.dueFiles, 1)
    assert.equal(out.filesPurged, 1)
    assert.equal(out.diskFilesDeleted, 3, '原檔＋display＋thumb 全刪')
    assert.equal(out.docsPiiCleared, 1)
    assert.equal(out.nameFieldsCleared, 2, 'extractedJson 1 ＋ line 1')
    assert.deepEqual(out.errors, [])
    assert.equal(state.files[F1].purgedAt?.toISOString(), CRON_NOW, 'purgedAt = x-cron-now')

    // 碟清空
    assert.ok(!existsSync(join(tmp, F1KEY)))
    assert.ok(!existsSync(join(tmp, F1_PJ[0].displayKey)))
    assert.ok(!existsSync(join(tmp, F1_PJ[0].thumbKey)))

    // PII 清、金額／單號／Lab 留（§4.4）
    const ej = state.docs[D1].extractedJson
    assert.equal(ej.groups[0].patientNameRaw, null)
    assert.equal(ej.total, 1234.5)
    assert.equal(ej.docNoRaw, 'INV-1')
    assert.equal(ej.labNameRaw, 'Excel')
    assert.equal(ej.groups[0].amount, 900)
    assert.equal(state.lines[0].patientNameRaw, null)

    // audit：LAB_DOC_IMAGE_PURGE 只數量零姓名
    const pa = state.auditRows.find((a) => a.action === 'LAB_DOC_IMAGE_PURGE')
    assert.ok(pa)
    assert.ok(!JSON.stringify(pa).includes('CHAN TEST A'), 'purge audit 零姓名')

    // 同一檔 GET → 410（T15 purged-410 收尾）
    const r1 = await GET_ORIG(req(token(OWNER, 'OWNER'), `http://localhost/api/lab-docs/files/${F1}/original`) as any, { params: { fileId: F1 } })
    assert.equal(r1.status, 410)
    assert.match((await r1.json()).error, /原檔已按保留政策（7 年）於 2026-10-05 刪除/)
    const r2 = await GET_PAGE(req(token(OWNER, 'OWNER'), `http://localhost/api/lab-docs/files/${F1}/pages/1`) as any, { params: { fileId: F1, n: '1' } })
    assert.equal(r2.status, 410)

    // 冪等：再跑 = no-op
    const res2 = await POST_PURGE(
      req(null, 'http://localhost/api/internal/labdoc-purge', 'POST', { 'x-cron-key': CRON_KEY, 'x-cron-now': CRON_NOW }) as any,
    )
    assert.equal(res2.status, 200)
    const out2 = await res2.json()
    assert.equal(out2.dueFiles, 0)
    assert.equal(out2.filesPurged, 0)
    assert.equal(out2.docsPiiCleared, 0, '冪等重跑唔再清 PII')
  })
})

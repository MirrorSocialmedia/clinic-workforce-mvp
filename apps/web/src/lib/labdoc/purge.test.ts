/**
 * cwm-labdoc P1 — purge 邏輯單測（§4.4，T16）
 *
 * 全 mock：fake prisma（monkey-patch，pattern 照 sync-availability-cache.test.ts）
 * ＋ 真 fs（mkdtemp 隔離目錄，LAB_DOC_DIR 指住 — 用完清）。
 *
 * 覆蓋：
 *   - 7 年邊界：purgeAt == now 到期（`<=`）；purgeAt = now+1 日 唔郁
 *   - PII 清 vs 金額留：單據**所有頁**purged 先清；金額／單號／病人編號／配對紀錄保留
 *   - T16 中途 throw：逐個檔隔離、run 唔崩、下次 run 接住做
 *   - 冪等：再跑 = no-op（唔重複 audit、唔重複計數）
 *   - orphan sweep 併入（gen1 決定 4）：碟有 DB 冇 >24h 刪；fresh 保留；DB 有保留
 *   - P3 LabStatementLine：表未建 skip；表存在清 patientRaw
 *   - audit LAB_DOC_IMAGE_PURGE：只數量、零姓名
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { prisma, basePrisma } from '../prisma'
import { runLabDocPurge, stripNameFields } from './purge'

type Any = any

// ── fake DB 狀態 ─────────────────────────────────────────────
interface FFile { id: string; storageKey: string; pagesJson: Any; purgeAt: Date; purgedAt: Date | null }
interface FDoc { id: string; clinicId: string | null; extractedJson: Any }
interface FLine { id: string; documentId: string; patientNameRaw: string | null; amount: number; patientCodeRaw: string | null; costCaseId: string | null }
interface FPage { documentId: string; fileId: string }
interface FStmt { documentId: string; patientRaw: string | null }

let files: FFile[] = []
let docs: FDoc[] = []
let lines: FLine[] = []
let pages: FPage[] = []
let statementTable = false
let statementRows: FStmt[] = []
let auditRows: Any[] = []
let failUpdateForFile: string | null = null

function mkFile(id: string, key: string, purgeAt: Date, pagesJson: Any = []): FFile {
  return { id, storageKey: key, pagesJson, purgeAt, purgedAt: null }
}

// ── fake prisma（同 purge.ts／storage.ts 用嘅 call 形狀對住寫）──
const fakes = {
  labFile: {
    findMany: async (args: Any) => {
      // storage.ts loadDbStorageKeys：select { storageKey, pagesJson }（無 id、無 where）
      if (args?.select && args.select.id === undefined) {
        return files.map((f) => ({ storageKey: f.storageKey, pagesJson: f.pagesJson }))
      }
      // purge step 1：where { purgeAt: { lte }, purgedAt: null }
      const lte = args?.where?.purgeAt?.lte as Date
      return files
        .filter((f) => f.purgedAt === null && f.purgeAt.getTime() <= lte.getTime())
        .map((f) => ({ id: f.id, storageKey: f.storageKey, pagesJson: f.pagesJson }))
    },
    updateMany: async (args: Any) => {
      const id = args.where.id as string
      if (failUpdateForFile === id) throw new Error('injected DB failure (T16)')
      let n = 0
      for (const f of files) {
        if (f.id === id && args.where.purgedAt === null && f.purgedAt === null) {
          f.purgedAt = new Date(args.data.purgedAt.getTime())
          n++
        }
      }
      return { count: n }
    },
  },
  labDocument: {
    // purge step 2：some（≥1 頁已 purged）AND every（全部頁已 purged）
    findMany: async () =>
      docs
        .filter((d) => {
          const p = pages.filter((x) => x.documentId === d.id)
          if (p.length === 0) return false
          const fids = p.map((x) => x.fileId)
          const purged = (fid: string) => files.find((f) => f.id === fid)?.purgedAt !== null
          return fids.some(purged) && fids.every(purged)
        })
        .map((d) => ({ id: d.id, clinicId: d.clinicId })),
    findUnique: async (args: Any) => {
      const d = docs.find((x) => x.id === args.where.id)
      return d ? { id: d.id, extractedJson: d.extractedJson } : null
    },
    update: async (args: Any) => {
      const d = docs.find((x) => x.id === args.where.id)
      if (d) Object.assign(d, args.data)
      return d ?? null
    },
  },
  labDocumentLine: {
    updateMany: async (args: Any) => {
      let n = 0
      for (const l of lines) {
        if (l.documentId === args.where.documentId && args.where.patientNameRaw?.not === null && l.patientNameRaw !== null) {
          l.patientNameRaw = null
          n++
        }
      }
      return { count: n }
    },
  },
  $transaction: async (cb: (tx: Any) => Promise<Any>) => cb(txFake),
  $queryRaw: async () => [{ exists: statementTable }],
  $executeRaw: async (_strings: TemplateStringsArray, ...vals: Any[]) => {
    const docId = vals[0] as string
    if (!statementTable) throw new Error('relation "LabStatementLine" does not exist')
    let n = 0
    for (const r of statementRows) {
      if (r.documentId === docId && r.patientRaw !== null) {
        r.patientRaw = null
        n++
      }
    }
    return n
  },
  auditLog: {
    create: async (args: Any) => {
      auditRows.push(args.data)
      return args.data
    },
  },
}
const txFake = {
  labDocument: fakes.labDocument,
  labDocumentLine: fakes.labDocumentLine,
  $queryRaw: fakes.$queryRaw,
  $executeRaw: fakes.$executeRaw,
}

let tmp = ''
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

/** 寫個假「加密」檔落 LAB_DOC_DIR；ageMs 由 refNow 倒數（sweep mtime 判斷用） */
function putFile(key: string, ageMs = 0, refNow: Date = new Date()): void {
  const abs = join(tmp, key)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, Buffer.from('fake-encrypted-blob'))
  const t = new Date(refNow.getTime() - ageMs)
  utimesSync(abs, t, t)
}
const exists = (key: string) => existsSync(join(tmp, key))

let saved: [Any, string, Any][] = []
const OLD_ENV: Record<string, string | undefined> = {}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'labdoc-purge-test-'))
  for (const k of ['LAB_DOC_DIR', 'LAB_DOC_ENC_KEY', 'LAB_DOC_ENC_KID']) {
    OLD_ENV[k] = process.env[k]
  }
  process.env.LAB_DOC_DIR = tmp
  process.env.LAB_DOC_ENC_KEY = randomBytes(32).toString('base64')
  process.env.LAB_DOC_ENC_KID = 'k1'
  for (const obj of [prisma, basePrisma]) {
    for (const k of Object.keys(fakes) as (keyof typeof fakes)[]) {
      saved.push([obj, k, (obj as Any)[k]])
      Object.defineProperty(obj, k, { value: fakes[k], configurable: true, writable: true })
    }
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
  files = []
  docs = []
  lines = []
  pages = []
  statementTable = false
  statementRows = []
  auditRows = []
  failUpdateForFile = null
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
})

// ── stripNameFields（純函數）─────────────────────────────────

describe('stripNameFields — 遞迴清姓名欄', () => {
  it('嵌套 object/array 全清；只計非 null；其他欄原樣', () => {
    const src = {
      labNameRaw: 'Test Lab',
      groups: [
        { patientNameRaw: 'A', lines: [{ patientNameRaw: 'B', amount: 900 }] },
        { patientRaw: 'C', patientName: 'D', patientFullName: 'E', patientCode: 'TW000001' },
      ],
    }
    const [cleaned, n] = stripNameFields(src) as [Any, number]
    assert.equal(n, 5) // A B C D E
    assert.equal(cleaned.groups[0].patientNameRaw, null)
    assert.equal(cleaned.groups[0].lines[0].patientNameRaw, null)
    assert.equal(cleaned.groups[0].lines[0].amount, 900) // 金額原樣
    assert.equal(cleaned.groups[1].patientRaw, null)
    assert.equal(cleaned.groups[1].patientName, null)
    assert.equal(cleaned.groups[1].patientFullName, null)
    assert.equal(cleaned.groups[1].patientCode, 'TW000001') // 病人編號原樣
    assert.equal(cleaned.labNameRaw, 'Test Lab')
  })

  it('已經 null 嘅姓名欄唔再計；冇姓名欄 → 0 且內容不變', () => {
    const [c1, n1] = stripNameFields({ patientNameRaw: null }) as [Any, number]
    assert.equal(n1, 0)
    assert.equal(c1.patientNameRaw, null)
    const [c2, n2] = stripNameFields({ amount: 5, docNo: 'INV-1' }) as [Any, number]
    assert.equal(n2, 0)
    assert.deepEqual(c2, { amount: 5, docNo: 'INV-1' })
  })
})

// ── runLabDocPurge ───────────────────────────────────────────

describe('runLabDocPurge — §4.4 保留同 purging', () => {
  it('7 年邊界：purgeAt == now 到期（<=）先 purge；now+1 日 唔郁', async () => {
    const now = new Date(Date.UTC(2033, 9, 5, 3, 30)) // = 2026-10-05 上傳 + 7 年
    const k1 = '2026/10/faaaaaaaaaaaaaaaaaaaaaaaa.bin'
    const k2 = '2026/10/fbbbbbbbbbbbbbbbbbbbbbbbb.bin'
    files = [
      mkFile('faaaaaaaaaaaaaaaaaaaaaaaa', k1, now),
      mkFile('fbbbbbbbbbbbbbbbbbbbbbbbb', k2, new Date(now.getTime() + DAY)),
    ]
    putFile(k1, 0, now)
    putFile(k2, 0, now)

    const out = await runLabDocPurge({ now, audit: false })
    assert.equal(out.dueFiles, 1)
    assert.equal(out.filesPurged, 1)
    assert.equal(files[0].purgedAt?.toISOString(), now.toISOString())
    assert.equal(files[1].purgedAt, null)
    assert.ok(!exists(k1), '到期檔要刪')
    assert.ok(exists(k2), '未到期檔要留')
  })

  it('PII：單據所有頁 purged 先清；金額／單號／病人編號／配對紀錄保留', async () => {
    const now0 = new Date(Date.UTC(2033, 9, 5, 3, 30))
    const k1 = '2026/10/fcccccccccccccccccccccccc.bin'
    const k2 = '2026/10/fdddddddddddddddddddddddd.bin'
    files = [
      mkFile('fcccccccccccccccccccccccc', k1, now0),
      mkFile('fdddddddddddddddddddddddd', k2, new Date(now0.getTime() + DAY)),
    ]
    putFile(k1, 0, now0)
    putFile(k2, 0, now0)
    docs = [
      {
        id: 'feeeeeeeeeeeeeeeeeeeeeeee',
        clinicId: 'cl1',
        extractedJson: {
          labNameRaw: 'Test Lab',
          docNoRaw: 'INV-331005001',
          total: 1350,
          groups: [
            {
              patientNameRaw: 'CHAN TEST A',
              patientCodeRaw: 'TW000001',
              lines: [{ description: 'CROWNING', qty: 2, unitPrice: 450, amount: 900, patientNameRaw: 'CHAN TEST A' }],
            },
            { patientRaw: 'LEE TEST B', patientName: 'LEE TEST B', patientCode: 'TW000002' },
          ],
        },
      },
    ]
    lines = [
      { id: 'ff11111111111111111111111', documentId: 'feeeeeeeeeeeeeeeeeeeeeeee', patientNameRaw: 'CHAN TEST A', amount: 900, patientCodeRaw: 'TW000001', costCaseId: 'cc1' },
      { id: 'ff22222222222222222222222', documentId: 'feeeeeeeeeeeeeeeeeeeeeeee', patientNameRaw: null, amount: 450, patientCodeRaw: 'TW000002', costCaseId: null },
    ]
    pages = [
      { documentId: 'feeeeeeeeeeeeeeeeeeeeeeee', fileId: 'fcccccccccccccccccccccccc' },
      { documentId: 'feeeeeeeeeeeeeeeeeeeeeeee', fileId: 'fdddddddddddddddddddddddd' },
    ]

    // run 1：只 f1 到期 → 檔刪咗但 PII 未清（f2 未 purged）
    const out1 = await runLabDocPurge({ now: now0, audit: false })
    assert.equal(out1.filesPurged, 1)
    assert.equal(out1.docsPiiCleared, 0)
    assert.equal(out1.nameFieldsCleared, 0)
    assert.equal(docs[0].extractedJson.groups[0].patientNameRaw, 'CHAN TEST A') // 未清
    assert.equal(lines[0].patientNameRaw, 'CHAN TEST A')

    // run 2：f2 都到期 → 所有頁 purged → 清 PII
    const out2 = await runLabDocPurge({ now: new Date(now0.getTime() + DAY), audit: false })
    assert.equal(out2.filesPurged, 1)
    assert.equal(out2.docsPiiCleared, 1)
    assert.equal(out2.nameFieldsCleared, 5) // extractedJson 4（A×2、B×2）＋ line 1

    const ej = docs[0].extractedJson
    assert.equal(ej.groups[0].patientNameRaw, null)
    assert.equal(ej.groups[0].lines[0].patientNameRaw, null)
    assert.equal(ej.groups[1].patientRaw, null)
    assert.equal(ej.groups[1].patientName, null)
    // 保留（§4.4：金額、單號、病人編號、配對紀錄）
    assert.equal(ej.labNameRaw, 'Test Lab')
    assert.equal(ej.docNoRaw, 'INV-331005001')
    assert.equal(ej.total, 1350)
    assert.equal(ej.groups[0].lines[0].amount, 900)
    assert.equal(ej.groups[0].patientCodeRaw, 'TW000001')
    assert.equal(ej.groups[1].patientCode, 'TW000002')
    assert.equal(lines[0].patientNameRaw, null)
    assert.equal(lines[0].amount, 900)
    assert.equal(lines[0].patientCodeRaw, 'TW000001')
    assert.equal(lines[0].costCaseId, 'cc1') // 配對紀錄保留
    assert.equal(lines[1].patientCodeRaw, 'TW000002')
  })

  it('T16 中途 throw：逐個檔隔離、run 唔崩、下次 run 接住做', async () => {
    const now = new Date(Date.UTC(2033, 9, 5, 3, 30))
    const kA = '2026/10/f555555555555555555555555.bin'
    const kB = '2026/10/f666666666666666666666666.bin'
    const idA = 'f555555555555555555555555'
    const idB = 'f666666666666666666666666'
    files = [mkFile(idA, kA, now), mkFile(idB, kB, now)]
    putFile(kA, 0, now)
    putFile(kB, 0, now)

    failUpdateForFile = idA // A 嘅 DB commit 炸
    let crashed = false
    let out1: Any = null
    try {
      out1 = await runLabDocPurge({ now, audit: false })
    } catch {
      crashed = true
    }
    assert.equal(crashed, false, 'run 唔應該崩')
    assert.equal(files.find((f) => f.id === idA)?.purgedAt, null, 'A：DB 未 commit → 下次重試')
    assert.ok(!exists(kA), 'A：碟上檔已刪（commit 前）— 重試要容忍 ENOENT')
    assert.equal(files.find((f) => f.id === idB)?.purgedAt?.toISOString(), now.toISOString(), 'B：照常 purged')
    assert.equal(out1!.errors.length, 1)
    assert.match(out1!.errors[0], /f555555555555555555555555/)

    failUpdateForFile = null // 第二次 run 接住做
    const out2 = await runLabDocPurge({ now, audit: false })
    assert.equal(out2.filesPurged, 1)
    assert.equal(out2.errors.length, 0)
    assert.equal(files.find((f) => f.id === idA)?.purgedAt?.toISOString(), now.toISOString())
    assert.ok(!exists(kB) === false || true) // B 第一次已刪
    assert.ok(!exists(kB))
  })

  it('冪等：全部 purge 完再跑 = no-op（0 檔、0 PII、冇 audit 行）', async () => {
    const now = new Date(Date.UTC(2033, 9, 5, 3, 30))
    const k1 = '2026/10/f777777777777777777777777.bin'
    const id1 = 'f777777777777777777777777'
    files = [mkFile(id1, k1, now)]
    putFile(k1, 0, now)
    docs = [{ id: 'f888888888888888888888888', clinicId: null, extractedJson: { patientNameRaw: 'CHAN TEST A' } }]
    pages = [{ documentId: 'f888888888888888888888888', fileId: id1 }]

    const out1 = await runLabDocPurge({ now })
    assert.equal(out1.filesPurged, 1)
    assert.equal(out1.docsPiiCleared, 1)
    assert.equal(auditRows.length, 1)

    const out2 = await runLabDocPurge({ now })
    assert.equal(out2.dueFiles, 0)
    assert.equal(out2.filesPurged, 0)
    assert.equal(out2.docsPiiCleared, 0)
    assert.equal(out2.nameFieldsCleared, 0)
    assert.equal(auditRows.length, 1, 'no-op run 唔可以再寫 audit')
  })

  it('orphan sweep 併入（gen1 決定 4）：>24h 孤兒刪；fresh 保留；DB 有嘅保留', async () => {
    const now = new Date(Date.UTC(2033, 9, 5, 3, 30))
    const kDb = '2026/10/f999999999999999999999999.bin'
    files = [mkFile('f999999999999999999999999', kDb, new Date(now.getTime() + 30 * DAY))] // 未到期
    putFile(kDb, 0, now) // DB 有 → 保留
    const kOrphan = '2033/01/f000000000000000000000000.bin'
    const kFresh = '2033/02/f000000000000000000000001.bin'
    const kOldTmp = '2033/03/f000000000000000000000002.bin.tmp'
    putFile(kOrphan, 30 * HOUR, now) // 碟有 DB 冇、30h → 刪
    putFile(kFresh, 1 * HOUR, now) // fresh（<24h）→ 保留
    putFile(kOldTmp, 30 * HOUR, now) // 舊 .tmp 殘留 → 刪

    const out = await runLabDocPurge({ now, audit: false })
    assert.equal(out.filesPurged, 0)
    assert.equal(out.orphansSwept, 2)
    assert.ok(exists(kDb), 'DB 有嘅檔要留')
    assert.ok(!exists(kOrphan))
    assert.ok(exists(kFresh))
    assert.ok(!exists(kOldTmp))
  })

  it('P3 LabStatementLine：表未建 → skip 唔炸；表存在 → 清 patientRaw', async () => {
    const now = new Date(Date.UTC(2033, 9, 5, 3, 30))
    const k1 = '2026/10/f333333333333333333333333.bin'
    const id1 = 'f333333333333333333333333'
    files = [mkFile(id1, k1, now)]
    putFile(k1, 0, now)
    const docId = 'f444444444444444444444444'
    docs = [{ id: docId, clinicId: null, extractedJson: null }]
    pages = [{ documentId: docId, fileId: id1 }]
    statementRows = [{ documentId: docId, patientRaw: 'WONG TEST C' }]

    // run 1：P3 表未建（P1 狀態）→ 照跑、唔炸、statement 未郁
    statementTable = false
    const out1 = await runLabDocPurge({ now, audit: false })
    assert.equal(out1.filesPurged, 1)
    assert.equal(out1.errors.length, 0)
    assert.equal(out1.nameFieldsCleared, 0)
    assert.equal(statementRows[0].patientRaw, 'WONG TEST C')

    // run 2：P3 表已建 → 同一張單據（全部頁已 purged）再核 → 清 patientRaw
    statementTable = true
    const out2 = await runLabDocPurge({ now, audit: false })
    assert.equal(out2.filesPurged, 0)
    assert.equal(out2.docsPiiCleared, 1)
    assert.equal(out2.nameFieldsCleared, 1)
    assert.equal(statementRows[0].patientRaw, null)
  })

  it('audit LAB_DOC_IMAGE_PURGE：只數量、零姓名', async () => {
    const now = new Date(Date.UTC(2033, 9, 5, 3, 30))
    const k1 = '2026/10/f222222222222222222222222.bin'
    const id1 = 'f222222222222222222222222'
    files = [mkFile(id1, k1, now)]
    putFile(k1, 0, now)
    const docId = 'f111111111111111111111111'
    docs = [{ id: docId, clinicId: 'cl9', extractedJson: { patientNameRaw: 'CHAN TEST A', total: 100 } }]
    pages = [{ documentId: docId, fileId: id1 }]

    const out = await runLabDocPurge({ now })
    assert.equal(out.filesPurged, 1)
    assert.equal(auditRows.length, 1)
    const row = auditRows[0]
    assert.equal(row.action, 'LAB_DOC_IMAGE_PURGE')
    const dump = JSON.stringify(row)
    assert.ok(!dump.includes('CHAN TEST A'), 'audit 唔可以含姓名值')
    assert.ok(!dump.includes('patientNameRaw'), 'audit 唔可以含姓名欄名')
    assert.match(row.notes, /files=1\/1/)
    assert.match(row.notes, /nameFields=1/)
    const after = JSON.parse(row.afterJson)
    assert.equal(after.filesPurged, 1)
    assert.equal(after.nameFieldsCleared, 1)
  })
})

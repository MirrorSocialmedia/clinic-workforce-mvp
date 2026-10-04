/**
 * cwm-labdoc P1 — T8 存檔庫單測（§4.1：storageKey 防 path traversal、tmp+fsync+rename、孤兒 sweep）
 * 跑法: npx tsx --test src/lib/labdoc/storage.test.ts
 *
 * 真 fs（mkdtemp 隔離 LAB_DOC_DIR，用完清）＋ fake prisma（只 sweepOrphans
 * 嘅 loadDbStorageKeys 用 — pattern 照 purge.test.ts 嘅 monkey-patch）。
 *
 * 覆蓋（purge.test.ts 已有 >24h 刪/fresh 留/DB 有留/.tmp 清 — 呢度唔重複，
 *   只補 sweepOrphans 直接 edge case）：
 *   - buildStorageKey/buildPageKey：HK wall-clock 月份前綴（UTC 16:00+ 跨日）
 *   - keyToPath：path traversal／唔合格式 storageKey → throw
 *   - saveEncrypted → readEncrypted round-trip；碟上 LDOC1；無 .tmp 殘留
 *   - deleteEncrypted：真刪 = true；唔存在 = false（ENOENT 容忍）
 *   - sweepOrphans：唔認得嘅形狀（.txt 等）>24h 都唔郁；nested 子目錄孤兒會清
 */
import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { prisma } from '../prisma'
import {
  STORAGE_KEY_RE,
  buildStorageKey,
  buildPageKey,
  keyToPath,
  saveEncrypted,
  readEncrypted,
  deleteEncrypted,
  fileExists,
  sweepOrphans,
} from './storage'

type Any = any

const ID25 = 'f111111111111111111111111' // 25 位 lowercase
const HOUR = 3600 * 1000
const DAY = 24 * HOUR

// ── fake DB（sweepOrphans → loadDbStorageKeys 用）────────────
let dbKeys: { storageKey: string; pagesJson: Array<{ displayKey?: string; thumbKey?: string }> }[] = []
const fakes = {
  labFile: {
    findMany: async () => dbKeys,
  },
}
let saved: [Any, Any][] = []

let tmp = ''
const OLD_ENV: Record<string, string | undefined> = {}

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'labdoc-storage-test-'))
  for (const k of ['LAB_DOC_DIR', 'LAB_DOC_ENC_KEY', 'LAB_DOC_ENC_KID']) {
    OLD_ENV[k] = process.env[k]
  }
  process.env.LAB_DOC_DIR = tmp
  process.env.LAB_DOC_ENC_KEY = randomBytes(32).toString('base64')
  process.env.LAB_DOC_ENC_KID = 'k1'
  saved.push([prisma, (prisma as Any).labFile])
  Object.defineProperty(prisma, 'labFile', { value: fakes.labFile, configurable: true, writable: true })
})
after(() => {
  for (const [obj, orig] of saved) {
    Object.defineProperty(obj, 'labFile', { value: orig, configurable: true, writable: true })
  }
  for (const [k, v] of Object.entries(OLD_ENV)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(tmp, { recursive: true, force: true })
})
beforeEach(() => {
  dbKeys = []
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(tmp, { recursive: true })
})

/** 寫個檔落 tmp（ageMs 由 refNow 倒數 — sweep mtime 判斷用） */
function putFile(rel: string, content: Buffer | string, ageMs: number, refNow: Date): void {
  const abs = join(tmp, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
  const t = new Date(refNow.getTime() - ageMs)
  utimesSync(abs, t, t)
}

describe('T8 存檔庫 — storageKey 格式（§4.1 防 path traversal）', () => {
  it('buildStorageKey/buildPageKey：HK wall-clock 月份前綴', () => {
    // UTC 2026-10-04T16:00Z = HK 2026-10-05 00:00 → 月份 2026/10
    const hkMidnight = new Date('2026-10-04T16:00:00Z')
    assert.match(buildStorageKey(ID25, hkMidnight), /^2026\/10\//)
    // UTC 2026-10-04T15:59:59Z = HK 2026-10-04 23:59:59 → 月份 2026/10（唔跨日）
    const beforeHkMidnight = new Date('2026-10-04T15:59:59Z')
    assert.match(buildStorageKey(ID25, beforeHkMidnight), /^2026\/10\//)
    // 普通日子
    assert.equal(buildStorageKey(ID25, new Date('2026-01-15T03:00:00Z')), '2026/01/' + ID25 + '.bin')
    assert.equal(
      buildPageKey(ID25, new Date('2026-01-15T03:00:00Z'), 2, 'display'),
      `2026/01/${ID25}.p2.jpg.bin`,
    )
    assert.equal(
      buildPageKey(ID25, new Date('2026-01-15T03:00:00Z'), 2, 'thumb'),
      `2026/01/${ID25}.p2.thumb.jpg.bin`,
    )
    // 全部 key 格式過 STRICT regex
    for (const k of [
      buildStorageKey(ID25, hkMidnight),
      buildPageKey(ID25, hkMidnight, 30, 'display'),
      buildPageKey(ID25, hkMidnight, 30, 'thumb'),
    ]) {
      assert.ok(STORAGE_KEY_RE.test(k), k)
    }
  })

  it('keyToPath：path traversal／唔合格式 storageKey → throw', () => {
    assert.throws(() => keyToPath('../../etc/passwd'), /invalid storageKey/)
    assert.throws(() => keyToPath('2026/10/../../secret.bin'), /invalid storageKey/)
    assert.throws(() => keyToPath('2026/10/UPPERUPPERUPPERUPPERUPPER.bin'), /invalid storageKey/) // 大写唔接受
    assert.throws(() => keyToPath('2026/10/short.bin'), /invalid storageKey/)
    assert.throws(() => keyToPath('2026/10/' + ID25.slice(0, 20) + '.bin'), /invalid storageKey/) // 20 位唔夠

    // 合格 key → 路徑喺 root 下
    const abs = keyToPath('2026/10/' + ID25 + '.bin')
    assert.ok(abs.startsWith(tmp + '/'))
    assert.equal(abs, join(tmp, '2026/10/' + ID25 + '.bin'))
  })
})

describe('T8 存檔庫 — save/read/delete（tmp+fsync+rename 原子寫）', () => {
  it('saveEncrypted → readEncrypted round-trip；碟上 LDOC1 加密 blob；無 .tmp 殘留', async () => {
    const plain = randomBytes(4096)
    const key = buildStorageKey(ID25, new Date('2026-10-05T03:00:00Z'))
    await saveEncrypted(key, plain)

    assert.ok(await fileExists(key))
    const onDisk = readFileSync(join(tmp, key))
    assert.equal(onDisk.subarray(0, 5).toString('ascii'), 'LDOC1', '碟上必須係加密 blob（LDOC1 頭）')
    assert.ok(!onDisk.includes(plain), '碟上唔可以含明文')
    assert.ok(!(await fileExists(key + '.tmp')), 'rename 成功後唔可以有 .tmp 殘留')

    const back = await readEncrypted(key)
    assert.ok(back.equals(plain), '解密讀返必須逐 byte 相同')
  })

  it('saveEncrypted：唔合格 storageKey → throw，碟上無任何新檔', async () => {
    await assert.rejects(() => saveEncrypted('../evil.bin', Buffer.from('x')))
    assert.ok(!existsSync(join(tmp, '..', 'evil.bin'))) // 真身喺 tmp 外 — 唔可以寫到
  })

  it('deleteEncrypted：真刪 = true；唔存在（ENOENT）= false（purge 冪等重試靠呢個）', async () => {
    const key = buildStorageKey(ID25, new Date('2026-10-05T03:00:00Z'))
    await saveEncrypted(key, Buffer.from('x'))
    assert.equal(await deleteEncrypted(key), true)
    assert.ok(await fileExists(key) === false)
    assert.equal(await deleteEncrypted(key), false, '第二次刪（已冇）= false，唔 throw')
  })

  it('readEncrypted：檔唔存在 → throw（缺檔明示，唔好回空）', async () => {
    await assert.rejects(() => readEncrypted('2026/10/' + ID25 + '.bin'), /missing/)
  })
})

describe('T8 存檔庫 — sweepOrphans edge（§4.1；>24h/fresh/DB 有 嘅主行為喺 purge.test.ts）', () => {
  it('唔認得嘅形狀（.txt／奇怪副檔名）>24h 都唔郁（保守：只清 .bin/.bin.tmp）', async () => {
    const now = new Date('2026-10-05T03:30:00Z')
    putFile('readme.txt', 'hello', 30 * HOUR, now)
    putFile('2033/05/notes.txt', 'nested', 30 * HOUR, now)
    putFile('2033/05/' + ID25 + '.bin.bak', 'weird', 30 * HOUR, now)

    const n = await sweepOrphans(now)
    assert.equal(n, 0)
    assert.ok(existsSync(join(tmp, 'readme.txt')))
    assert.ok(existsSync(join(tmp, '2033/05/notes.txt')))
    assert.ok(existsSync(join(tmp, '2033/05/' + ID25 + '.bin.bak')))
  })

  it('nested 子目錄嘅 >24h 孤兒 .bin 會清；DB 有嘅舊檔保留（對照）', async () => {
    const now = new Date('2026-10-05T03:30:00Z')
    const dbKey = `2026/10/${ID25}.bin`
    dbKeys = [{ storageKey: dbKey, pagesJson: [] }]
    putFile(dbKey, Buffer.from('db-owned'), 30 * HOUR, now) // DB 有 → 留
    const orphanKey = `2033/05/f222222222222222222222222.bin`
    putFile(orphanKey, Buffer.from('orphan'), 30 * HOUR, now) // DB 冇 → 清

    const n = await sweepOrphans(now)
    assert.equal(n, 1)
    assert.ok(existsSync(join(tmp, dbKey)), 'DB 有嘅檔要留')
    assert.ok(!existsSync(join(tmp, orphanKey)), '孤兒要清')
  })
})

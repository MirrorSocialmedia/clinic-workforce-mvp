// ============================================================
// FX-31（workforce 側 contract test — 唔佔 T 號）— 報價項重跑唔復活
// workorder cwi-qa-fix-20260928 FX-31（QA-31）：
//   舊口徑：storeQuotesForVisit 只 deleteMany(pending) 然後 createMany 全部
//   → 已 confirmed/corrected/discarded 嘅項再建一份 pending → 確認隊列見返已處理嘅嘢
//   而家：建之前讀同 sourceVisitId 嘅非 pending 項，(termShorthand, fdiTeeth)
//   相同嘅 key 唔再建（跳過）；stored = 實際新建行数。
//
// DB：dev 15532（CWM_TEST_DATABASE_URL 可覆蓋）— 只寫 QuotedItem（固定 visitId）
//   + ClinicalTermMap FX31 前綴行；before() pre-clean（冪等）、after() 必跑
//   cleanup + 零殘留 assert。
// 零 LLM：測試 note 全字典命中（needsLlm=false）＋ skipLlm=true 雙保險 — 確定性。
// ⚠️ 本 repo tsx 跑 CJS — 唔准 top-level await；prisma module 必須喺
//   DATABASE_URL 設定之後先動態 import（.env auto-load 陷阱 — 見
//   payroll-snapshot-asof-write.test.ts 註解）。所有 import 都入 before()。
// ============================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const TERM_IDS = ['FX31IMPL', 'FX31FILL']
const V1 = 'e2efx31v1visit20260928x1'
const V2 = 'e2efx31v2visit20260928x1'
const V3 = 'e2efx31v3visit20260928x1'
const V4 = 'e2efx31v4visit20260928x1'
const ALL_VISITS = [V1, V2, V3, V4]
const CLINIC = 'e2efx31clinicx1'
const PATIENT = 'e2efx31patientx1'
// 兩 note 皆純字典命中（probe 實測：NOTE_2 → 2 項、NOTE_1 → 1 項、needsLlm=false）：
// NOTE_2：FX31IMPL 36/37（FDI）＋ FX31FILL 900@（perUnit）→ 2 項
// NOTE_1：FX31FILL 900@ → 1 項
const NOTE_2 = { kind: 'STANDARD', complaints: '', findings: 'quoted FX31IMPL 36 37 / FX31FILL 900@', diagnosis: '', actions: '' } as const
const NOTE_1 = { kind: 'STANDARD', complaints: '', findings: 'quoted FX31FILL 900@', diagnosis: '', actions: '' } as const

type Mod = { basePrisma: any; storeQuotesForVisit: any; resetTermCache: any }
let M: Mod
let dbDown = false

before(async () => {
  // 1) DB env 先定先 import prisma（.env auto-load 陷阱）
  const DB_URL = process.env.CWM_TEST_DATABASE_URL ?? 'postgresql://cw_dev:cw_dev_pw_2026@127.0.0.1:15532/clinic_workforce?schema=public'
  process.env.DATABASE_URL = DB_URL
  const [prisma, qe] = await Promise.all([import('@/lib/prisma'), import('./quote-extract')])
  M = {
    basePrisma: prisma.basePrisma,
    storeQuotesForVisit: qe.storeQuotesForVisit,
    resetTermCache: qe.resetTermCache,
  }
  // 2) pre-clean（冪等）＋術語表 seed（FX31 前綴）
  try {
    await M.basePrisma.quotedItem.deleteMany({ where: { sourceVisitId: { in: ALL_VISITS } } })
    await M.basePrisma.clinicalTermMap.deleteMany({ where: { shorthand: { in: TERM_IDS } } })
    await M.basePrisma.clinicalTermMap.create({ data: { shorthand: 'FX31IMPL', nameCn: '測試植牙（FX31）', nameEn: 'implant', usedFor: ['quote_extraction'] } })
    await M.basePrisma.clinicalTermMap.create({ data: { shorthand: 'FX31FILL', nameCn: '測試補牙（FX31）', nameEn: 'filling', usedFor: ['quote_extraction'] } })
  } catch (e) {
    dbDown = true
    console.warn(`[FX31] skip — 連唔到測試 DB（設 CWM_TEST_DATABASE_URL 可覆蓋）：${(e as Error)?.message}`)
    await M.basePrisma.$disconnect().catch(() => {})
  }
  M.resetTermCache()
})

after(async () => {
  if (!dbDown) {
    await M.basePrisma.quotedItem.deleteMany({ where: { sourceVisitId: { in: ALL_VISITS } } })
    await M.basePrisma.clinicalTermMap.deleteMany({ where: { shorthand: { in: TERM_IDS } } })
    // 零殘留
    assert.equal(await M.basePrisma.quotedItem.count({ where: { sourceVisitId: { in: ALL_VISITS } } }), 0)
    assert.equal(await M.basePrisma.clinicalTermMap.count({ where: { shorthand: { in: TERM_IDS } } }), 0)
  }
})

const store = (visitId: string, note: typeof NOTE_1 | typeof NOTE_2) =>
  M.storeQuotesForVisit({ visitId, clinicId: CLINIC, patientApricotId: PATIENT, visitDate: new Date('2026-09-28T00:00:00Z'), note, skipLlm: true })

const rows = (visitId: string) => M.basePrisma.quotedItem.findMany({ where: { sourceVisitId: visitId }, orderBy: { createdAt: 'asc' as const } })

const decide = (id: string, status: string, extra?: Record<string, unknown>) =>
  M.basePrisma.quotedItem.update({ where: { id }, data: { status, decidedBy: 'fx31-e2e', decidedAt: new Date(), ...extra } })

test('FX31-0 新 visit 首跑：2 項 → 2 pending（baseline）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const { stored } = await store(V1, NOTE_2)
  assert.equal(stored, 2)
  const all = await rows(V1)
  assert.equal(all.length, 2)
  assert.ok(all.every((r: any) => r.status === 'pending'))
})

test('FX31-1 confirm 一項 → 同 visit 重跑 → pending 數不變（spec 測試）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const target = (await rows(V1)).find((r: any) => r.termShorthand === 'FX31IMPL')!
  assert.ok(target)
  await decide(target.id, 'confirmed')
  const { stored } = await store(V1, NOTE_2)
  assert.equal(stored, 1, '只剩未決定嘅 FX31FILL 重建')
  const all = await rows(V1)
  assert.equal(all.length, 2, '1 confirmed ＋ 1 新 pending')
  const pending = all.filter((r: any) => r.status === 'pending')
  assert.equal(pending.length, 1, 'pending 數不變')
  assert.equal(pending[0].termShorthand, 'FX31FILL', '重建嘅係未決定項')
  assert.equal(all.filter((r: any) => r.termShorthand === 'FX31IMPL').length, 1, 'confirmed 項唔會再建第二份')
  assert.equal(all.find((r: any) => r.termShorthand === 'FX31IMPL').status, 'confirmed')
})

test('FX31-2 discarded 亦唔復活', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const pend = (await rows(V1)).find((r: any) => r.status === 'pending')!
  assert.ok(pend)
  await decide(pend.id, 'discarded')
  const { stored } = await store(V1, NOTE_2)
  assert.equal(stored, 0, '全部已決定 → 零重建')
  const all = await rows(V1)
  assert.equal(all.filter((r: any) => r.status === 'pending').length, 0)
  assert.equal(all.filter((r: any) => r.status === 'confirmed').length, 1)
  assert.equal(all.filter((r: any) => r.status === 'discarded').length, 1)
})

test('FX31-3 corrected 保留（correctionNote 原封不動）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  await store(V2, NOTE_2)
  const target = (await rows(V2)).find((r: any) => r.termShorthand === 'FX31FILL')!
  assert.ok(target)
  await decide(target.id, 'corrected', { correctionNote: '900 → 1200' })
  const { stored } = await store(V2, NOTE_2)
  assert.equal(stored, 1)
  const corr = (await rows(V2)).find((r: any) => r.termShorthand === 'FX31FILL')!
  assert.equal(corr.status, 'corrected', '決定行唔覆寫')
  assert.equal(corr.correctionNote, '900 → 1200')
  const pending = (await rows(V2)).filter((r: any) => r.status === 'pending')
  assert.equal(pending.length, 1)
  assert.deepEqual(pending[0].fdiTeeth, ['36', '37'])
})

test('FX31-4 無決定 → 重跑 = pending 重建（regression：原冪等口徑唔變）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  assert.equal((await store(V3, NOTE_2)).stored, 2)
  assert.equal((await store(V3, NOTE_2)).stored, 2)
  const all = await rows(V3)
  assert.equal(all.length, 2, '重建唔係 append（唔係 4）')
  assert.ok(all.every((r: any) => r.status === 'pending'))
})

test('FX31-5 重跑新增項會建、已決定唔復活（唔會過度過濾）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const first = await store(V4, NOTE_1)
  assert.equal(first.stored, 1)
  const target = (await rows(V4)).find((r: any) => r.termShorthand === 'FX31FILL')!
  assert.ok(target)
  await decide(target.id, 'confirmed')
  const second = await store(V4, NOTE_2)
  assert.equal(second.stored, 1, '只建新出現嘅 FX31IMPL')
  const all = await rows(V4)
  assert.equal(all.length, 2)
  assert.equal(all.filter((r: any) => r.status === 'pending').length, 1)
  assert.deepEqual(all.find((r: any) => r.status === 'pending').fdiTeeth, ['36', '37'])
})

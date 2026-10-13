// ============================================================
// ★ cwm-dailyreview2-20261014：核對同事覆核 —— 真 Postgres 對抗式測試（寫入狀態機＋併發）
//   跑法: CWM_TEST_DATABASE_URL=postgres://… TZ=UTC npx tsx --test src/lib/payout/daily-doctor-review-db.test.ts
//   直接行 production 嘅 applyDoctorReviews（route 經 setDoctorReviews 用 loadDailyReport 計 current 再 call 佢）。
//   fixture：e2edr- 前綴（clinicId／providerId 係字串，冇外鍵）；after() 必清 + 零殘留。
//   AuditLog append-only → 審計行同固定測試用戶留低（按設計）。
// ============================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

const P = 'e2edr-'
const ACTOR = `${P}actor`
const CL = `${P}clinic`
const DR = `${P}doctor`
let db: any
let L: typeof import('./daily-doctor-review')
let dbDown = false

const cur = (o: Record<string, Record<string, number>>) =>
  new Map(Object.entries(o).map(([d, bm]) => [d, { byMethod: bm, doctorRaw: Object.values(bm).reduce((a, b) => a + b, 0), storeTotal: Object.values(bm).reduce((a, b) => a + b, 0) }]))
const active = async (date?: string) => db.dailyDoctorReview.findMany({ where: { clinicId: CL, providerId: DR, revokedAt: null, ...(date ? { date } : {}) }, orderBy: { date: 'asc' } })
const apply = (dates: string[], checked: boolean, current: Map<string, any>, name = '測試核對') =>
  L.applyDoctorReviews(db, { clinicId: CL, providerId: DR, dates, checked, actorId: ACTOR, reviewerName: name }, current)

before(async () => {
  process.env.DATABASE_URL = process.env.CWM_TEST_DATABASE_URL ?? 'postgresql://cw_dev:***@127.0.0.1:15532/clinic_workforce?schema=public'
  const [pm, l] = await Promise.all([import('@/lib/prisma'), import('./daily-doctor-review')])
  db = pm.basePrisma; L = l
  try { await db.$queryRaw`SELECT 1` } catch { dbDown = true; return }
  await db.dailyDoctorReview.deleteMany({ where: { clinicId: { startsWith: P } } })
  await db.user.upsert({ where: { id: ACTOR }, create: { id: ACTOR, name: 'E2E 核對同事', phone: '90000000-e2edr', password: 'x', role: 'OWNER' }, update: {} })
})

after(async () => {
  if (!dbDown && db) {
    await db.dailyDoctorReview.deleteMany({ where: { clinicId: { startsWith: P } } })
    assert.equal(await db.dailyDoctorReview.count({ where: { clinicId: { startsWith: P } } }), 0, '零殘留')
  }
  await db?.$disconnect()
})

test('剔：寫快照、留名、審計；冇收款／未來日子跳過；重複剔冇變唔重寫', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const c = cur({ '2026-10-04': { CASH: 5000, VISA: 4500 }, '2026-10-05': {}, '2099-01-01': { CASH: 1 } })
  const r = await apply(['2026-10-04', '2026-10-05', '2099-01-01', '2026-10-09'], true, c, 'May')
  assert.deepEqual(r.reviewed, ['2026-10-04'])
  assert.deepEqual(r.skipped.map(s => s.date).sort(), ['2026-10-05', '2026-10-09', '2099-01-01'])
  const [row] = await active('2026-10-04')
  assert.equal(row.reviewerName, 'May')
  assert.equal(row.reviewedBy, ACTOR)
  assert.deepEqual(row.snapshotJson, { CASH: 5000, VISA: 4500 })
  assert.equal(row.doctorRaw.toString(), '9500')
  const audit = await db.auditLog.findFirst({ where: { actorId: ACTOR, action: 'DAILY_DOCTOR_REVIEW', clinicId: CL }, orderBy: { createdAt: 'desc' } })
  assert.match(audit.notes, /May/)
  const again = await apply(['2026-10-04'], true, c)
  assert.deepEqual([again.reviewed, again.unchanged], [[], ['2026-10-04']])
  assert.equal((await db.dailyDoctorReview.count({ where: { clinicId: CL, date: '2026-10-04' } })), 1, '冇變唔會多寫一條')
})

test('有變再剔：舊嗰條標取消、寫新快照；取消：留紀錄唔刪；取消冇紀錄嘅日子唔出錯', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const r = await apply(['2026-10-04'], true, cur({ '2026-10-04': { CASH: 5000, VISA: 4600 } }))
  assert.deepEqual(r.reviewed, ['2026-10-04'])
  const rows = await db.dailyDoctorReview.findMany({ where: { clinicId: CL, date: '2026-10-04' }, orderBy: { reviewedAt: 'asc' } })
  assert.equal(rows.length, 2)
  assert.ok(rows[0].revokedAt && rows[0].revokedBy === ACTOR)
  assert.equal(rows[1].revokedAt, null)
  assert.deepEqual(rows[1].snapshotJson, { CASH: 5000, VISA: 4600 })

  const u = await apply(['2026-10-04', '2026-10-20'], false, new Map())
  assert.deepEqual(u.revoked, ['2026-10-04'])
  assert.equal((await active('2026-10-04')).length, 0)
  assert.equal(await db.dailyDoctorReview.count({ where: { clinicId: CL, date: '2026-10-04' } }), 2, '取消唔刪紀錄')
  assert.ok(await db.auditLog.findFirst({ where: { actorId: ACTOR, action: 'DAILY_DOCTOR_REVIEW_REVOKE', clinicId: CL } }))
})

test('輸入：冇日子／日期格式錯 → 擋', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  await assert.rejects(apply([], true, new Map()), /冇揀日子/)
  await assert.rejects(apply(['2026/10/04'], true, new Map()), /日期格式/)
  await assert.rejects(apply(["2026-10-04' OR 1=1 --"], true, new Map()), /日期格式/)
})

test('DB 兜底：同一格唔可以有兩條有效紀錄（partial unique index）', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const data = { clinicId: CL, providerId: DR, date: '2026-10-11', snapshotJson: { A: 1 }, doctorRaw: '1', storeTotal: '1', reviewedBy: ACTOR, reviewerName: 'x' }
  await db.dailyDoctorReview.create({ data })
  await assert.rejects(db.dailyDoctorReview.create({ data }))
  await db.dailyDoctorReview.updateMany({ where: { clinicId: CL, date: '2026-10-11' }, data: { revokedAt: new Date() } })
  await db.dailyDoctorReview.create({ data }) // 取消咗之後可以再有一條
})

test('真併發：同一日 10 個人同時剔（數字仲有唔同版本）→ 永遠只得 1 條有效，快照係其中一個版本', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const date = '2026-10-12'
  const versions = Array.from({ length: 10 }, (_, i) => ({ CASH: 1000 + (i % 3) }))
  const res = await Promise.allSettled(versions.map((v, i) => apply([date], true, cur({ [date]: v }), `同事${i}`)))
  assert.equal(res.filter(r => r.status === 'rejected').length, 0, JSON.stringify(res.filter(r => r.status === 'rejected')))
  const act = await active(date)
  assert.equal(act.length, 1)
  assert.ok([1000, 1001, 1002].includes((act[0].snapshotJson as any).CASH))
})

test('真併發：一次過剔成個月 vs 同時取消其中幾日 → 結束時每日最多 1 條有效，取消嗰邊冇殘留半條', async (t) => {
  if (dbDown) return t.skip('冇測試 DB')
  const month: Record<string, Record<string, number>> = {}
  for (let d = 1; d <= 28; d++) month[`2026-09-${String(d).padStart(2, '0')}`] = { VISA: d * 10 }
  const dates = Object.keys(month)
  for (let round = 0; round < 5; round++) {
    await Promise.all([
      apply(dates, true, cur(month)),
      apply(dates.slice(0, 10), false, new Map()),
      apply(dates.slice(5, 15), true, cur(month)),
    ])
    const rows = await db.dailyDoctorReview.groupBy({ by: ['date'], where: { clinicId: CL, providerId: DR, date: { in: dates }, revokedAt: null }, _count: { _all: true } })
    assert.ok(rows.every((r: any) => r._count._all === 1), `第 ${round} 輪有一日多過 1 條有效`)
  }
})

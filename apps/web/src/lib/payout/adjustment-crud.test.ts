// ★ cwm-adjedit-20261013：手動調整改／刪規則（fake DB，唔使 Postgres）
//   跑法: TZ=UTC npx tsx --test src/lib/payout/adjustment-crud.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateAdjustmentInput, updateAdjustment, deleteAdjustment, AdjustmentError } from './adjustment-crud'

const base = { providerId: 'p1', clinicId: 'c1', periodMonth: '2026-10', reason: 'MANUAL', amount: -100, note: ' 錄錯 ' }

test('validate：0.07／−12.34 唔會因浮點誤判；三位小數、$0、VOID 正數擋', () => {
  for (const amount of [0.07, -12.34, 1.1, 0.29, 999999.99]) {
    const v = validateAdjustmentInput({ ...base, amount })
    assert.equal(v.ok, true, String(amount))
  }
  const ok = validateAdjustmentInput({ ...base, amount: '0.07' })
  assert.ok(ok.ok && ok.data.amount === 0.07 && ok.data.note === '錄錯' && ok.data.sourceMonth === '2026-10' && ok.data.refCode === null)
  assert.deepEqual(validateAdjustmentInput({ ...base, amount: 1.234 }), { ok: false, error: '金額唔可以係 $0，最多兩個小數位' })
  assert.deepEqual(validateAdjustmentInput({ ...base, amount: 0 }), { ok: false, error: '金額唔可以係 $0，最多兩個小數位' })
  assert.equal(validateAdjustmentInput({ ...base, amount: '' }).ok, false)
  assert.deepEqual(validateAdjustmentInput({ ...base, reason: 'VOID', amount: 5 }), { ok: false, error: '作廢回沖金額必須係負數' })
  assert.deepEqual(validateAdjustmentInput({ ...base, amount: 2_000_000 }), { ok: false, error: '金額異常' })
  assert.deepEqual(validateAdjustmentInput({ ...base, amount: 'abc' }), { ok: false, error: '金額異常' })
  assert.equal(validateAdjustmentInput({ ...base, periodMonth: '2026-13' }).ok, false)
  assert.equal(validateAdjustmentInput({ ...base, sourceMonth: '2026/09' }).ok, false)
  assert.equal(validateAdjustmentInput({ ...base, reason: 'BONUS' }).ok, false)
  assert.equal(validateAdjustmentInput({ ...base, clinicId: '' }).ok, false)
})

type Adj = { id: string; runId: string | null; providerId: string; clinicId: string | null; periodMonth: string; sourceMonth: string; reason: string; refCode: string | null; amount: number; note: string }

function fakeDb(opts: { adj?: Partial<Adj> | null; lockedPeriods?: string[]; raceRunId?: string } = {}) {
  const rows = new Map<string, Adj>()
  if (opts.adj !== null) {
    rows.set('a1', { id: 'a1', runId: null, providerId: 'p1', clinicId: 'c1', periodMonth: '2026-10', sourceMonth: '2026-10', reason: 'MANUAL', refCode: null, amount: -100, note: '', ...(opts.adj ?? {}) })
  }
  const locks: string[] = []
  const audits: any[] = []
  const locked = new Set(opts.lockedPeriods ?? [])
  const db: any = {
    rows, locks, audits,
    payoutAdjustment: {
      findUnique: async ({ where }: any) => (rows.get(where.id) ? { ...rows.get(where.id)! } : null),
      updateMany: async ({ where, data }: any) => {
        const r = rows.get(where.id)
        if (!r || r.runId !== where.runId) return { count: 0 }
        rows.set(where.id, { ...r, ...data, amount: Number(data.amount) })
        return { count: 1 }
      },
      deleteMany: async ({ where }: any) => {
        const r = rows.get(where.id)
        if (!r || r.runId !== where.runId) return { count: 0 }
        rows.delete(where.id)
        return { count: 1 }
      },
    },
    provider: { findUnique: async ({ where }: any) => (where.id.startsWith('p') ? { id: where.id } : null) },
    clinic: { findUnique: async ({ where }: any) => (where.id.startsWith('c') ? { id: where.id } : null) },
    payoutRun: {
      findFirst: async ({ where }: any) => (locked.has(`${where.providerId}:${where.clinicId}:${where.periodMonth}`) ? { id: 'run-L' } : null),
    },
    auditLog: { create: async ({ data }: any) => { audits.push(data); return data } },
    $executeRaw: async (_s: TemplateStringsArray, key: string) => { locks.push(key); return 1 },
    $transaction: async (fn: any) => {
      // 模擬「讀完之後、攞鎖之前」月結啱啱鎖咗呢筆
      if (opts.raceRunId) { const r = rows.get('a1'); if (r) rows.set('a1', { ...r, runId: opts.raceRunId }) }
      return fn(db)
    },
  }
  return db
}

const input = (over: any = {}) => {
  const v = validateAdjustmentInput({ ...base, ...over })
  assert.ok(v.ok)
  return v.data
}
const all = () => true

async function rejects(p: Promise<unknown>, status: number) {
  await assert.rejects(p, (e: any) => e instanceof AdjustmentError && e.status === status)
}

test('update：未入月結 → 改到、寫審計（前後值）、新舊期間都鎖（排序去重）', async () => {
  const db = fakeDb()
  const out = await updateAdjustment(db, 'a1', input({ amount: -80, periodMonth: '2026-11' }), 'u1', all)
  assert.equal(out.amount, -80)
  assert.equal(out.periodMonth, '2026-11')
  assert.deepEqual(db.locks, ['payout-period:p1:c1:2026-10', 'payout-period:p1:c1:2026-11'])
  assert.equal(db.audits.length, 1)
  assert.equal(db.audits[0].action, 'PAYOUT_ADJUST_UPDATE')
  assert.equal(JSON.parse(db.audits[0].beforeJson).amount, -100)
  assert.equal(JSON.parse(db.audits[0].afterJson).amount, -80)

  const db2 = fakeDb()
  await updateAdjustment(db2, 'a1', input({ amount: -50 }), 'u1', all)
  assert.deepEqual(db2.locks, ['payout-period:p1:c1:2026-10']) // 同一期只鎖一次
})

test('update：已入月結（草稿或鎖定）→ 409，唔改', async () => {
  const db = fakeDb({ adj: { runId: 'run-D' } })
  await rejects(updateAdjustment(db, 'a1', input({ amount: -1 }), 'u1', all), 409)
  assert.equal(db.rows.get('a1').amount, -100)
  assert.equal(db.audits.length, 0)
})

test('update：舊期間或新期間已鎖定 → 409', async () => {
  const dbOld = fakeDb({ lockedPeriods: ['p1:c1:2026-10'] })
  await rejects(updateAdjustment(dbOld, 'a1', input({ periodMonth: '2026-11' }), 'u1', all), 409)
  assert.equal(dbOld.rows.get('a1').periodMonth, '2026-10')
  const dbNew = fakeDb({ lockedPeriods: ['p1:c2:2026-10'] })
  await rejects(updateAdjustment(dbNew, 'a1', input({ clinicId: 'c2' }), 'u1', all), 409)
  assert.equal(dbNew.rows.get('a1').clinicId, 'c1')
})

test('update：讀完之後啱啱被鎖入月結（runId 變咗）→ 條件寫入 count 0 → 409', async () => {
  const db = fakeDb({ raceRunId: 'run-L2' })
  await rejects(updateAdjustment(db, 'a1', input({ amount: -1 }), 'u1', all), 409)
  assert.equal(db.rows.get('a1').amount, -100)
  assert.equal(db.audits.length, 0)
})

test('update：唔存在 404；醫生／診所唔存在 400；店舖帳號（舊或新診所唔係自己店）403', async () => {
  await rejects(updateAdjustment(fakeDb({ adj: null }), 'a1', input(), 'u1', all), 404)
  await rejects(updateAdjustment(fakeDb(), 'a1', input({ providerId: 'x9' }), 'u1', all), 400)
  const onlyC1 = (c: string | null) => c === 'c1'
  await rejects(updateAdjustment(fakeDb(), 'a1', input({ clinicId: 'c2' }), 'u1', onlyC1), 403)
  await rejects(updateAdjustment(fakeDb({ adj: { clinicId: 'c2' } }), 'a1', input(), 'u1', onlyC1), 403)
})

test('delete：未入月結 → 刪、審計留底；已入月結／已鎖定期間／race → 409；KIOSK 別店 403', async () => {
  const db = fakeDb()
  await deleteAdjustment(db, 'a1', 'u1', all)
  assert.equal(db.rows.has('a1'), false)
  assert.equal(db.audits[0].action, 'PAYOUT_ADJUST_DELETE')
  assert.equal(JSON.parse(db.audits[0].beforeJson).amount, -100)
  assert.deepEqual(db.locks, ['payout-period:p1:c1:2026-10'])

  for (const d of [fakeDb({ adj: { runId: 'run-L' } }), fakeDb({ lockedPeriods: ['p1:c1:2026-10'] }), fakeDb({ raceRunId: 'run-L2' })]) {
    await rejects(deleteAdjustment(d, 'a1', 'u1', all), 409)
    assert.equal(d.rows.has('a1'), true)
    assert.equal(d.audits.length, 0)
  }
  await rejects(deleteAdjustment(fakeDb(), 'a1', 'u1', (c) => c === 'c9'), 403)
  await rejects(deleteAdjustment(fakeDb({ adj: null }), 'a1', 'u1', all), 404)
})

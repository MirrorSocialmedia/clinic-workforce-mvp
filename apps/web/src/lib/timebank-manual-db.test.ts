// ============================================================
// ★ cwm-tbmanual-20261017 ①：時間帳戶手動調整 —— 真 Postgres 對抗式測試（MD §1.7）
// 跑法: CWM_TEST_DATABASE_URL=postgres://… TZ=UTC npx tsx --test src/lib/timebank-manual-db.test.ts
//
//   直接行 production route handler（manual-adjust / reverse / preview / init-adjust），
//   用自己嘅 fixture（e2etm- 前綴：1 個 OWNER user + 1 個員工 + 1 條月薪 pay rule），
//   遠未來月份 2031-07 唔會撞真數據；after() 必清 + 零殘留 assert。
//   AuditLog append-only（trigger 擋刪）→ 審計行同 fixture user 會留低（同 e2emc- 一樣，按設計）。
//   ⚠️ tsx 跑 CJS：prisma 要喺 DATABASE_URL 設定之後先 import（.env auto-load 陷阱），全部 import 入 before()。
// ============================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const P = 'e2etm-'
const OWNER_USER = `${P}owner`
const EMP = `${P}emp1`
const MONTH = '2031-07' // 遠未來月份，唔會撞真數據
const MONTH_END = new Date(`${MONTH}-01T00:00:00+08:00`)

let db: any
let POST_ADJUST: any
let POST_REVERSE: any
let GET_PREVIEW: any
let POST_INIT: any
let createToken: any
let tok: string
let dbDown = false

async function cleanup() {
  // 順序跟 FK：PayrollItem → PayrollRun；TimeBankEntry／TimeBank／snapshot；PayRule
  await db.payrollItem.deleteMany({ where: { employeeId: EMP } })
  await db.payrollRun.deleteMany({ where: { id: { startsWith: P } } })
  await db.timeBankEntry.deleteMany({ where: { employeeId: EMP } })
  await db.timeBank.deleteMany({ where: { employeeId: EMP } })
  await db.timeBankLedgerSnapshot.deleteMany({ where: { employeeId: EMP } })
  await db.payRule.deleteMany({ where: { employeeId: EMP } })
  // ★ Employee／User 刻意唔刪（系統特性，非呢單引入）：
  //   AuditLog.targetEmployeeId FK = ON DELETE SET NULL，但 AuditLog 有 append-only trigger
  //   （no_mutate_audit）→ SET NULL 嘅 UPDATE 被擋 → 有 audit targeting 嘅員工永遠刪唔到。
  //   固定 ID + upsert ⇒ 冪等重跑；audit 行 + fixture 員工／用戶留低（同 e2emc- 一樣，按設計）。
  await db.auditLog.deleteMany({ where: { entityId: EMP } }).catch(() => {}) // append-only，必 fail，只係嘗試
}

before(async () => {
  process.env.DATABASE_URL = process.env.CWM_TEST_DATABASE_URL ?? 'postgresql://cw_dev:***@127.0.0.1:15532/clinic_workforce?schema=public'
  const [pm, adj, rev, prev, init, auth] = await Promise.all([
    import('@/lib/prisma'),
    import('../app/api/timebank/manual-adjust/route'),
    import('../app/api/timebank/manual-adjust/reverse/route'),
    import('../app/api/timebank/manual-adjust/preview/route'),
    import('../app/api/timebank/init-adjust/route'),
    import('./auth'),
  ])
  db = pm.basePrisma
  POST_ADJUST = adj.POST
  POST_REVERSE = rev.POST
  GET_PREVIEW = prev.GET
  POST_INIT = init.POST
  createToken = auth.createToken
  tok = createToken({ userId: OWNER_USER, role: 'OWNER', clinics: [], tokenVersion: 1 })
  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    dbDown = true
    return
  }
  await cleanup()
  await db.user.upsert({
    where: { id: OWNER_USER },
    create: { id: OWNER_USER, name: 'E2E 時間帳戶', phone: '90000000-e2etm', password: 'x', role: 'OWNER', tokenVersion: 1 },
    update: { role: 'OWNER', tokenVersion: 1 },
  })
  // ★ upsert（唔係 create）：employee 留低唔到（見 cleanup 註）→ 重跑必冪等
  await db.employee.upsert({
    where: { id: EMP },
    create: { id: EMP, userId: OWNER_USER, joinDate: new Date('2026-01-05T00:00:00Z') },
    update: { userId: OWNER_USER },
  })
  await db.payRule.create({
    data: {
      employeeId: EMP, payType: 'MONTHLY', baseAmount: 15000,
      configJson: JSON.stringify({ base_type: 'monthly', monthly_salary: 15000, negative_carry: 'next_month' }),
      effectiveFrom: new Date('2026-01-01T00:00:00Z'), createdBy: OWNER_USER,
    },
  })
})

after(async () => {
  if (!dbDown && db) {
    await cleanup()
    // 零殘留（可清嘅範圍）；employee／user／audit 行按設計留低（見 cleanup 註）
    const left = await Promise.all([
      db.timeBankEntry.count({ where: { employeeId: EMP } }),
      db.timeBank.count({ where: { employeeId: EMP } }),
      db.timeBankLedgerSnapshot.count({ where: { employeeId: EMP } }),
      db.payRule.count({ where: { employeeId: EMP } }),
      db.payrollRun.count({ where: { id: { startsWith: P } } }),
      db.payrollItem.count({ where: { employeeId: EMP } }),
    ])
    assert.deepEqual(left, [0, 0, 0, 0, 0, 0], '零殘留')
  }
  await db?.$disconnect()
})

const post = (fn: any, path: string, body: any) =>
  fn(new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `session=${tok}` },
    body: JSON.stringify(body),
  }))

const get = (fn: any, path: string) =>
  fn(new NextRequest(`http://localhost${path}`, {
    method: 'GET',
    headers: { cookie: `session=${tok}` },
  }))

const json = async (res: any) => ({ status: res.status, body: await res.json().catch(() => ({})) })

// ────────────────────────────────────────────────────────────
test('manual-adjust：加 +150 → balance 正確變', { skip: dbDown }, async () => {
  const prev0 = await json(await get(GET_PREVIEW, `/api/timebank/manual-adjust/preview?employeeId=${EMP}&month=${MONTH}`))
  assert.equal(prev0.status, 200, JSON.stringify(prev0))
  assert.equal(prev0.body.balance, 0, `新員工 2031-07 期初應為 0，得到 ${prev0.body.balance}`)

  const r = await json(await post(POST_ADJUST, '/api/timebank/manual-adjust', {
    employeeId: EMP, minutes: 150, effectiveMonth: MONTH, reason: 'e2e 加 150',
  }))
  assert.equal(r.status, 200, JSON.stringify(r))
  assert.equal(r.body.ok, true)
  assert.equal(r.body.balanceBefore, 0)
  assert.equal(r.body.balanceAfter, 150)
  assert.ok(r.body.entryId)

  // preview（calculateTimeBank 口徑）= 150
  const prev1 = await json(await get(GET_PREVIEW, `/api/timebank/manual-adjust/preview?employeeId=${EMP}&month=${MONTH}`))
  assert.equal(prev1.body.balance, 150)

  // 帳本行：MANUAL_ADJUST，note 有原因
  const entry = await db.timeBankEntry.findUnique({ where: { id: r.body.entryId } })
  assert.equal(entry.type, 'MANUAL_ADJUST')
  assert.equal(entry.minutes, 150)
  assert.equal(entry.reversesEntryId, null)
  assert.ok(String(entry.note).includes('e2e 加 150'))
})

test('manual-adjust：再加 −30 → 累加唔覆寫（120）', { skip: dbDown }, async () => {
  const r = await json(await post(POST_ADJUST, '/api/timebank/manual-adjust', {
    employeeId: EMP, minutes: -30, effectiveMonth: MONTH, reason: 'e2e 扣 30',
  }))
  assert.equal(r.status, 200, JSON.stringify(r))
  assert.equal(r.body.balanceBefore, 150)
  assert.equal(r.body.balanceAfter, 120)

  const rows = await db.timeBankEntry.findMany({ where: { employeeId: EMP, type: 'MANUAL_ADJUST' } })
  assert.equal(rows.length, 2, `累加 = 兩行都得，得到 ${rows.length}`)
  const prev = await json(await get(GET_PREVIEW, `/api/timebank/manual-adjust/preview?employeeId=${EMP}&month=${MONTH}`))
  assert.equal(prev.body.balance, 120)
})

test('manual-adjust：同 INIT_ADJUST 共存（初始化唔會刪手動調整）', { skip: dbDown }, async () => {
  // 初始化 = 覆寫 INIT_ADJUST（刪舊 INIT 再寫），MANUAL_ADJUST 必須原封不動
  const r = await json(await post(POST_INIT, '/api/timebank/init-adjust', {
    employeeId: EMP, minutes: 240, effectiveMonth: MONTH, reason: 'e2e 初始化',
  }))
  assert.equal(r.status, 200, JSON.stringify(r))

  const inits = await db.timeBankEntry.findMany({ where: { employeeId: EMP, type: 'INIT_ADJUST' } })
  assert.equal(inits.length, 1, '初始化只留一行 INIT_ADJUST')
  assert.equal(inits[0].minutes, 240)

  const manuals = await db.timeBankEntry.findMany({ where: { employeeId: EMP, type: 'MANUAL_ADJUST' } })
  assert.equal(manuals.length, 2, `初始化唔應該刪 MANUAL_ADJUST，得到 ${manuals.length}`)
  const sum = manuals.reduce((s: number, e: any) => s + e.minutes, 0)
  assert.equal(sum, 120)

  // 引擎 balance = INIT(240) + MANUAL(120) = 360
  const prev = await json(await get(GET_PREVIEW, `/api/timebank/manual-adjust/preview?employeeId=${EMP}&month=${MONTH}`))
  assert.equal(prev.body.balance, 360, JSON.stringify(prev.body))
})

test('manual-adjust：481 分鐘無 confirm → 409 CONFIRM_REQUIRED（零寫入）', { skip: dbDown }, async () => {
  const before_ = await db.timeBankEntry.count({ where: { employeeId: EMP } })
  const r = await json(await post(POST_ADJUST, '/api/timebank/manual-adjust', {
    employeeId: EMP, minutes: 481, effectiveMonth: MONTH, reason: 'e2e 大額',
  }))
  assert.equal(r.status, 409, JSON.stringify(r))
  assert.equal(r.body.code, 'CONFIRM_REQUIRED')
  assert.equal(await db.timeBankEntry.count({ where: { employeeId: EMP } }), before_)
  // 帶 confirmLarge 就過
  const r2 = await json(await post(POST_ADJUST, '/api/timebank/manual-adjust', {
    employeeId: EMP, minutes: 481, effectiveMonth: MONTH, reason: 'e2e 大額', confirmLarge: true,
  }))
  assert.equal(r2.status, 200, JSON.stringify(r2))
  // 還原：−481（confirmLarge）
  const r3 = await json(await post(POST_ADJUST, '/api/timebank/manual-adjust', {
    employeeId: EMP, minutes: -481, effectiveMonth: MONTH, reason: 'e2e 還原大額', confirmLarge: true,
  }))
  assert.equal(r3.status, 200, JSON.stringify(r3))
})

test('manual-adjust：已確認計糧月份 → 409，DB 冇新行（反向撤銷都一樣擋）', { skip: dbDown }, async () => {
  const runId = `${P}run-203107`
  await db.payrollRun.create({ data: { id: runId, clinicId: null, periodMonth: MONTH_END, status: 'FINALIZED' } })
  await db.payrollItem.create({ data: { runId, employeeId: EMP } })

  try {
    const before_ = await db.timeBankEntry.count({ where: { employeeId: EMP } })
    const r = await json(await post(POST_ADJUST, '/api/timebank/manual-adjust', {
      employeeId: EMP, minutes: 60, effectiveMonth: MONTH, reason: 'e2e 鎖月',
    }))
    assert.equal(r.status, 409, JSON.stringify(r))
    assert.equal(r.body.code, 'PAYROLL_LOCKED')
    assert.equal(await db.timeBankEntry.count({ where: { employeeId: EMP } }), before_, '鎖月唔准寫入')

    // ★ reverse 都必須擋（原本行月份 = 2031-07，已 FINALIZED）
    const orig = await db.timeBankEntry.findFirst({
      where: { employeeId: EMP, type: 'MANUAL_ADJUST', note: { contains: 'e2e 加 150' } },
    })
    assert.ok(orig)
    const r2 = await json(await post(POST_REVERSE, '/api/timebank/manual-adjust/reverse', { entryId: orig.id }))
    assert.equal(r2.status, 409, JSON.stringify(r2))
    assert.equal(r2.body.code, 'PAYROLL_LOCKED')
    const revs = await db.timeBankEntry.findMany({ where: { reversesEntryId: orig.id } })
    assert.equal(revs.length, 0, '鎖月撤銷零寫入')
  } finally {
    await db.payrollItem.deleteMany({ where: { runId } })
    await db.payrollRun.deleteMany({ where: { id: runId } })
  }
})

test('reverse：正常撤銷 → 相反數行 + 連結 + balance 還原', { skip: dbDown }, async () => {
  // 搵「e2e 加 150」嗰行
  const orig = await db.timeBankEntry.findFirst({ where: { employeeId: EMP, type: 'MANUAL_ADJUST', note: { contains: 'e2e 加 150' } } })
  assert.ok(orig, 'fixture 行唔見')
  const balBefore = (await json(await get(GET_PREVIEW, `/api/timebank/manual-adjust/preview?employeeId=${EMP}&month=${MONTH}`))).body.balance

  const r = await json(await post(POST_REVERSE, '/api/timebank/manual-adjust/reverse', { entryId: orig.id, reason: 'e2e 撤銷' }))
  assert.equal(r.status, 200, JSON.stringify(r))
  assert.ok(r.body.reversedEntryId)

  const rev = await db.timeBankEntry.findUnique({ where: { id: r.body.reversedEntryId } })
  assert.equal(rev.type, 'MANUAL_ADJUST')
  assert.equal(rev.minutes, -orig.minutes)
  assert.equal(rev.reversesEntryId, orig.id)
  assert.ok(String(rev.note).includes('e2e 撤銷'))

  const prev = await json(await get(GET_PREVIEW, `/api/timebank/manual-adjust/preview?employeeId=${EMP}&month=${MONTH}`))
  assert.equal(prev.body.balance, balBefore - orig.minutes)
})

test('reverse：第二次撤銷同一行 → 409「已經撤銷過」（partial unique）', { skip: dbDown }, async () => {
  const orig = await db.timeBankEntry.findFirst({ where: { employeeId: EMP, type: 'MANUAL_ADJUST', note: { contains: 'e2e 加 150' } } })
  assert.ok(orig)
  const r = await json(await post(POST_REVERSE, '/api/timebank/manual-adjust/reverse', { entryId: orig.id }))
  assert.equal(r.status, 409, JSON.stringify(r))
  assert.equal(r.body.code, 'ALREADY_REVERSED')
  // 撤銷行仍然只有一條
  const revs = await db.timeBankEntry.findMany({ where: { reversesEntryId: orig.id } })
  assert.equal(revs.length, 1)
})

test('reverse：並發兩個撤銷同一行 → 一個成功、一個 409', { skip: dbDown }, async () => {
  const r0 = await json(await post(POST_ADJUST, '/api/timebank/manual-adjust', {
    employeeId: EMP, minutes: 600, effectiveMonth: MONTH, reason: 'e2e 並發撤銷', confirmLarge: true,
  }))
  assert.equal(r0.status, 200, JSON.stringify(r0))

  const [a, b] = await Promise.all([
    post(POST_REVERSE, '/api/timebank/manual-adjust/reverse', { entryId: r0.body.entryId, reason: 'a' }),
    post(POST_REVERSE, '/api/timebank/manual-adjust/reverse', { entryId: r0.body.entryId, reason: 'b' }),
  ])
  const [ja, jb] = [await json(a), await json(b)]
  const statuses = [ja.status, jb.status].sort()
  assert.deepEqual(statuses, [200, 409], `一成功一 409，得到 ${JSON.stringify(statuses)}`)
  const revs = await db.timeBankEntry.findMany({ where: { reversesEntryId: r0.body.entryId } })
  assert.equal(revs.length, 1, 'partial unique 兜底：撤銷行只可以有一條')

  // 清理：撤銷走 600
  const okOne = [ja, jb].find(x => x.status === 200)!
  // （600 − 600 淨零，帳本淨效果 0，可留）
})

test('reverse：撤銷行本身再撤銷 → 400', { skip: dbDown }, async () => {
  const orig = await db.timeBankEntry.findFirst({ where: { employeeId: EMP, type: 'MANUAL_ADJUST', note: { contains: 'e2e 加 150' } } })
  const rev = await db.timeBankEntry.findFirst({ where: { reversesEntryId: orig.id } })
  assert.ok(rev)
  const r = await json(await post(POST_REVERSE, '/api/timebank/manual-adjust/reverse', { entryId: rev.id }))
  assert.equal(r.status, 400, JSON.stringify(r))
  const revs = await db.timeBankEntry.findMany({ where: { reversesEntryId: rev.id } })
  assert.equal(revs.length, 0)
})

test('preview：壞輸入 → 400', { skip: dbDown }, async () => {
  const r1 = await json(await get(GET_PREVIEW, '/api/timebank/manual-adjust/preview?month=2026-99'))
  assert.equal(r1.status, 400)
  const r2 = await json(await get(GET_PREVIEW, '/api/timebank/manual-adjust/preview?employeeId=x&month=2026-10'))
  assert.equal(r2.status, 404)
})

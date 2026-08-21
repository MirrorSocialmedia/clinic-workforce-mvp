/**
 * ★ 計糧 PUT — 假期餘額月結快照 hook 測試（2026-08-22 §6.2.2）
 * 跑法: npx tsx --test src/lib/payroll-run-snapshot-route.test.ts
 * （Node 22 內建 test runner）
 *
 * 覆蓋 §6.6 驗收：
 *   - #39 finalize → createMany「每員工 × 每 type 一行」（多員工 × 2 type = 2N 行），periodMonth = periodKey(run.periodMonth)
 *   - #39b REST_DAY 多曆年 row（上年＋本年）→ 按 (員工, type) 加總合併成一行（unique constraint 兜底）
 *   - #40 退回 DRAFT → leaveBalanceSnapshot.deleteMany where = { employeeId in [...], periodMonth: pk }
 *   - #41 finalize → revert → 再 finalize → 第二次 createMany 前必先 deleteMany（重 FINALIZE 唔重覆）
 *   - #50 finalize 寫入 同 revert 刪除 嘅 periodMonth 來自同一個 periodKey helper（string/Date 兩支路都對比）
 *
 * 設計（MD §6.2.2 建議版）：
 *   - 同 ROSTER_DIFF 一致「先刪後寫」—— 2 條 query 取代 N×4 條 upsert（transaction timeout 安全）
 *   - 員工列表複用 route 已有嘅 payrollItem 查詢（唔多發 query）
 *   - 快照值 = LeaveBalance.remaining 按 (employeeId, leaveTypeId) 加總（全 type 全 year 照原值；
 *     年假/生日假 year=0 累積制每人一行，加總＝原值）
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'
import { prisma, basePrisma } from './prisma'
import { createToken } from './auth'
import { PUT } from '../app/api/payroll-runs/[id]/route'

// ---- fake prisma（唔真連 DB）------------------------------------------------
type Any = any

const users: Record<string, Any> = {
  'u-owner': {
    tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
    clinics: [],
  },
}

// 「DB」狀態
let run: Any = null
let items: Any[] = []
let balanceRows: Any[] = []
let snapshotRows: Any[] = []
// 調用日誌（順序重要 —— #41 斷言先刪後寫）
let calls: Array<{ op: 'deleteMany' | 'createMany'; where: Any; data?: Any[] }> = []

const REST_LT = 'lt-rest'
const ANN_LT = 'lt-annual'

const fakeTx: Any = {
  payrollRun: {
    // ★ 同一個 fake 同時服務：route 頭部 findUnique（run.status/periodMonth）
    //   同 snapshotWagesForADW 內部 findUnique（run.items.detailJson 要計過 eoWage）
    findUnique: async () => run,
    update: async (args: Any) => ({ ...run, ...args.data }),
  },
  payrollItem: {
    findMany: async (args: Any) => {
      // finalize 端用 include（employee 完整 object）；revert 端用 select: { employeeId }
      if (args?.select?.employeeId) return items.map(i => ({ employeeId: i.employeeId }))
      return items
    },
  },
  leaveBalance: {
    findMany: async (args: Any) =>
      balanceRows.filter(b => (args?.where?.employeeId?.in ?? []).includes(b.employeeId)),
  },
  leaveBalanceSnapshot: {
    deleteMany: async (args: Any) => {
      calls.push({ op: 'deleteMany', where: args?.where })
      const before = snapshotRows.length
      const ids: string[] = args?.where?.employeeId?.in ?? []
      const pm: string | undefined = args?.where?.periodMonth
      snapshotRows = snapshotRows.filter(r => !(ids.includes(r.employeeId) && r.periodMonth === pm))
      return { count: before - snapshotRows.length }
    },
    createMany: async (args: Any) => {
      calls.push({ op: 'createMany', where: undefined, data: args?.data })
      snapshotRows.push(...(args?.data ?? []))
      return { count: (args?.data ?? []).length }
    },
  },
  timeBankEntry: {
    create: async () => ({ id: 'tb-1' }),
    deleteMany: async () => ({ count: 0 }),
  },
  // computeRosterHours 安全網（MONTHLY 員工 = 0 → 唔會行到呢啲 query）
  employee: { findMany: async () => [] },
  leaveRequest: { findMany: async () => [] },
  shift: { findMany: async () => [] },
  payRule: { findMany: async () => [] },
  auditLog: { create: async () => ({ id: 'al-1' }) },
}

const savedPrismaUser: Any = (prisma as Any).user
const savedPrismaPayrollRun: Any = (prisma as Any).payrollRun
const savedBaseTx: Any = (basePrisma as Any).$transaction

function resetState() {
  run = null
  items = []
  balanceRows = []
  snapshotRows = []
  calls = []
}

/** 2 名員工嘅 payroll items（payRules 空 → 非 MONTHLY → ROSTER_DIFF 分支直接跳過）。
 *  detailJson 要有 eoWage —— snapshotWagesForADW 嘅「引擎有冇計過」判斷（QA30）。 */
function makeItems() {
  const dj = JSON.stringify({ eoWage: 100 })
  return [
    { id: 'pi-1', employeeId: 'e1', employee: { id: 'e1', payRules: [] }, detailJson: dj },
    { id: 'pi-2', employeeId: 'e2', employee: { id: 'e2', payRules: [] }, detailJson: dj },
  ]
}

/** 每個員工 2 種假期（REST_DAY + ANNUAL_LEAVE）各一行 */
function makeBalances() {
  return [
    { employeeId: 'e1', leaveTypeId: REST_LT, remaining: 5 },
    { employeeId: 'e1', leaveTypeId: ANN_LT, remaining: 7.5 },
    { employeeId: 'e2', leaveTypeId: REST_LT, remaining: 9 },
    { employeeId: 'e2', leaveTypeId: ANN_LT, remaining: 3 },
  ]
}

function makeRun(status: 'DRAFT' | 'FINALIZED', periodMonth: string | Date) {
  return {
    id: RUN_ID,
    status,
    periodMonth,
    items, // snapshotWagesForADW 用；detailJson 要有 eoWage
  }
}

const ownerTok = createToken({ userId: 'u-owner', role: 'OWNER', clinics: [], tokenVersion: 1 })

// ★ RBAC normalizeRoute 只將 ≥20 位 alnum 或 ≥3 位數字嘅 segment 轉 /:id ——
//   用 cuid 格式嘅 run id（pr-1 呢種短 id 會 RBAC MISS → 403）
const RUN_ID = 'prun01234567890123456789'

function putReq(body: Any) {
  return new NextRequest(`http://localhost/api/payroll-runs/${RUN_ID}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: `session=${ownerTok}` },
    body: JSON.stringify(body),
  })
}

before(() => {
  Object.defineProperty(prisma, 'user', {
    value: { findUnique: async (args: Any) => users[args?.where?.id] ?? null },
    configurable: true, writable: true,
  })
  // route 頭部嘅 run 查詢走 prisma singleton（唔係 tx）—— 同 fake 共用一個 run
  Object.defineProperty(prisma, 'payrollRun', {
    value: { findUnique: async () => run },
    configurable: true, writable: true,
  })
  Object.defineProperty(basePrisma, '$transaction', {
    value: async (fn: Any) => fn(fakeTx),
    configurable: true, writable: true,
  })
})

after(() => {
  Object.defineProperty(prisma, 'user', { value: savedPrismaUser, configurable: true, writable: true })
  Object.defineProperty(prisma, 'payrollRun', { value: savedPrismaPayrollRun, configurable: true, writable: true })
  Object.defineProperty(basePrisma, '$transaction', { value: savedBaseTx, configurable: true, writable: true })
})

describe('payroll PUT — LeaveBalanceSnapshot hooks（2026-08-22 §6.2.2）', () => {
  it('#39 finalize：createMany 每員工 × 每 type 一行（2 員工 × 2 type = 4 行），periodMonth = periodKey', async () => {
    resetState()
    items = makeItems()
    balanceRows = makeBalances()
    run = makeRun('DRAFT', '2026-08')

    const res = await PUT(putReq({ status: 'FINALIZED' }), { params: { id: RUN_ID } })
    assert.equal(res.status, 200)

    const creates = calls.filter(c => c.op === 'createMany')
    assert.equal(creates.length, 1, 'finalize 應該 createMany 一次')
    const data = creates[0].data!
    assert.equal(data.length, 4, '2 員工 × 2 type = 4 行')
    // 每行 periodMonth 都係 periodKey(run.periodMonth) = '2026-08'
    for (const row of data) {
      assert.equal(row.periodMonth, '2026-08')
    }
    // 每 (員工, type) 組合都有且只有一行
    const combos = data
      .map(r => `${r.employeeId}|${r.leaveTypeId}`)
      .sort()
    assert.deepEqual(combos, [
      'e1|lt-annual', 'e1|lt-rest', 'e2|lt-annual', 'e2|lt-rest',
    ])
    // 值照原值 snapshot
    const byCombo = new Map(data.map(r => [`${r.employeeId}|${r.leaveTypeId}`, r.remaining]))
    assert.equal(byCombo.get('e1|lt-rest'), 5)
    assert.equal(byCombo.get('e2|lt-annual'), 3)
  })

  it('#39b REST_DAY 多曆年 row → 按 (員工, type) 加總合併（唔會撞 unique constraint）', async () => {
    resetState()
    items = makeItems()
    // e1 有 2025（剩 3）＋ 2026（預支成 -1）兩行 REST_DAY；e2 只有一行
    balanceRows = [
      { employeeId: 'e1', leaveTypeId: REST_LT, remaining: 3 },
      { employeeId: 'e1', leaveTypeId: REST_LT, remaining: -1 },
      { employeeId: 'e2', leaveTypeId: REST_LT, remaining: 4 },
    ]
    run = makeRun('DRAFT', '2026-08')

    const res = await PUT(putReq({ status: 'FINALIZED' }), { params: { id: RUN_ID } })
    assert.equal(res.status, 200)

    const data = calls.find(c => c.op === 'createMany')!.data!
    assert.equal(data.length, 2, 'e1 兩行 REST_DAY 合併成一行；e2 一行')
    const e1 = data.find(r => r.employeeId === 'e1')!
    assert.equal(e1.remaining, 2, '3 + (-1) = 2')
    const e2 = data.find(r => r.employeeId === 'e2')!
    assert.equal(e2.remaining, 4)
  })

  it('#40 退回 DRAFT：deleteMany where = { employeeId in [...], periodMonth: pk }', async () => {
    resetState()
    items = makeItems()
    run = makeRun('FINALIZED', '2026-08')
    // 預先有 finalize 時影低嘅快照
    snapshotRows = [
      { employeeId: 'e1', leaveTypeId: REST_LT, periodMonth: '2026-08', remaining: 5 },
      { employeeId: 'e2', leaveTypeId: REST_LT, periodMonth: '2026-08', remaining: 9 },
    ]

    const res = await PUT(putReq({ status: 'DRAFT', reason: '測試退回原因（≥5字）' }), { params: { id: RUN_ID } })
    assert.equal(res.status, 200)

    const deletes = calls.filter(c => c.op === 'deleteMany')
    assert.equal(deletes.length, 1, 'revert 應該 deleteMany 一次')
    assert.deepEqual(deletes[0].where, {
      employeeId: { in: ['e1', 'e2'] },
      periodMonth: '2026-08',
    })
    assert.equal(snapshotRows.length, 0, '快照要刪晒')
  })

  it('#41 finalize → revert → 再 finalize：第二次 createMany 前必先 deleteMany（重 FINALIZE 唔重覆）', async () => {
    resetState()
    items = makeItems()
    balanceRows = makeBalances()
    run = makeRun('DRAFT', '2026-08')

    // 1) finalize
    assert.equal((await PUT(putReq({ status: 'FINALIZED' }), { params: { id: RUN_ID } })).status, 200)
    assert.equal(snapshotRows.length, 4)

    // 2) revert
    run = makeRun('FINALIZED', '2026-08')
    assert.equal((await PUT(putReq({ status: 'DRAFT', reason: '測試退回原因（≥5字）' }), { params: { id: RUN_ID } })).status, 200)
    assert.equal(snapshotRows.length, 0)

    // 3) 再 finalize（餘額已變）
    balanceRows = [
      { employeeId: 'e1', leaveTypeId: REST_LT, remaining: 1 },
      { employeeId: 'e1', leaveTypeId: ANN_LT, remaining: 6 },
      { employeeId: 'e2', leaveTypeId: REST_LT, remaining: 2 },
      { employeeId: 'e2', leaveTypeId: ANN_LT, remaining: 0.5 },
    ]
    run = makeRun('DRAFT', '2026-08')
    assert.equal((await PUT(putReq({ status: 'FINALIZED' }), { params: { id: RUN_ID } })).status, 200)

    // 順序斷言：第二次 createMany 緊接之前嘅 op 必須係同 period 嘅 deleteMany
    const createIdx = calls.map((c, i) => (c.op === 'createMany' ? i : -1)).filter(i => i >= 0)
    assert.equal(createIdx.length, 2, 'createMany 應該行咗兩次')
    const secondCreate = createIdx[1]
    const beforeSecond = calls.slice(0, secondCreate).filter(c => c.op === 'deleteMany')
    assert.ok(beforeSecond.length >= 2, '第二次 createMany 前要有至少兩次 deleteMany（finalize 1 + revert）')
    const lastDeleteBefore = beforeSecond[beforeSecond.length - 1]
    assert.equal(lastDeleteBefore.where?.periodMonth, '2026-08')
    assert.deepEqual(lastDeleteBefore.where?.employeeId?.in, ['e1', 'e2'])

    // 唔重覆：最終快照 = 第二次 finalize 嘅 4 行（冇重複、冇累積）
    assert.equal(snapshotRows.length, 4)
    const e1Rest = snapshotRows.filter(r => r.employeeId === 'e1' && r.leaveTypeId === REST_LT)
    assert.equal(e1Rest.length, 1)
    assert.equal(e1Rest[0].remaining, 1, '新值覆蓋舊值')
  })

  it('#50 finalize 寫入 同 revert 刪除 嘅 periodMonth 來自同一 periodKey helper（string 入參）', async () => {
    resetState()
    items = makeItems()
    balanceRows = makeBalances()
    run = makeRun('DRAFT', '2026-08')

    assert.equal((await PUT(putReq({ status: 'FINALIZED' }), { params: { id: RUN_ID } })).status, 200)
    const writePm = calls.find(c => c.op === 'createMany')!.data![0]!.periodMonth

    run = makeRun('FINALIZED', '2026-08')
    assert.equal((await PUT(putReq({ status: 'DRAFT', reason: '測試退回原因（≥5字）' }), { params: { id: RUN_ID } })).status, 200)
    const deletePm = calls.filter(c => c.op === 'deleteMany').at(-1)!.where?.periodMonth

    assert.match(writePm, /^\d{4}-\d{2}$/, '寫入 periodMonth 格式 YYYY-MM')
    assert.equal(deletePm, writePm, '寫入/刪除 periodMonth 必須同一個 helper 輸出')
  })

  it('#50b periodMonth 係 Date 時，兩邊 helper 輸出都一致（toHKDateStr 支路）', async () => {
    resetState()
    items = makeItems()
    balanceRows = makeBalances()
    // 2026-08-15 04:00 HKT = 2026-08-14 20:00 UTC —— 用 HK 日期都得 '2026-08'
    run = makeRun('DRAFT', new Date('2026-08-15T04:00:00+08:00'))

    assert.equal((await PUT(putReq({ status: 'FINALIZED' }), { params: { id: RUN_ID } })).status, 200)
    const writePm = calls.find(c => c.op === 'createMany')!.data![0]!.periodMonth
    assert.equal(writePm, '2026-08', 'Date 入參 → HK 月份字串')

    run = makeRun('FINALIZED', new Date('2026-08-15T04:00:00+08:00'))
    assert.equal((await PUT(putReq({ status: 'DRAFT', reason: '測試退回原因（≥5字）' }), { params: { id: RUN_ID } })).status, 200)
    const deletePm = calls.filter(c => c.op === 'deleteMany').at(-1)!.where?.periodMonth
    assert.equal(deletePm, '2026-08')
    assert.equal(deletePm, writePm, 'Date 入參兩邊都同一個 helper 輸出')
  })

  it('403 非 OWNER 唔可以 finalize（RBAC 無變 —— 快照 hook 唔影響權限）', async () => {
    resetState()
    items = makeItems()
    run = makeRun('DRAFT', '2026-08')
    // RBAC_MATRIX: PUT /api/payroll-runs/:id = ['OWNER'] 限定
    const mgrTok = createToken({ userId: 'u-owner', role: 'MANAGER', clinics: [], tokenVersion: 1 })
    const res = await PUT(
      new NextRequest(`http://localhost/api/payroll-runs/${RUN_ID}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', cookie: `session=${mgrTok}` },
        body: JSON.stringify({ status: 'FINALIZED' }),
      }),
      { params: { id: RUN_ID } },
    )
    assert.equal(res.status, 403)
    assert.equal(calls.length, 0, '403 唔可以有快照寫入')
  })
})

/**
 * ★ scheduling-leave-summary route 測試（2026-08-22 §6.2.3 / §6.3）
 * 跑法: npx tsx --test src/lib/scheduling-leave-summary-route.test.ts
 * （Node 22 內建 test runner）
 *
 * 覆蓋 §6.6 驗收：
 *   - #42 九月份「上月剩」= 八月快照（snapshot 有 2026-08 行 → lastMonthRestRemaining = 該行值）
 *   - #42 跨年：view 2026-01 → 查 snapshot periodMonth 2025-12
 *   - #38 上月未 finalize 過（snapshot 空）→ lastMonthRestRemaining = null
 *     （★ 唔係 0、唔係當前值 —— 零 fallback；當前值 restBalanceRemaining 照常回）
 *   - #42b REST_DAY 多曆年 row（上年＋本年）→ restBalanceRemaining 按員工加總
 *   - #37 API 回傳齊兩新欄 + 頁面 thead 欄序 員工｜上月剩｜R｜PL｜R+PL｜剩餘｜年假（服務年度）
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { prisma } from './prisma'
import { createToken } from './auth'
import { GET } from '../app/api/scheduling-leave-summary/route'

// ---- fake prisma（唔真連 DB）------------------------------------------------
type Any = any

const ownerUser = {
  tokenVersion: 1, status: 'ACTIVE', ipAllowlist: null, permissionsJson: null,
  clinics: [],
}

let restBalanceRows: Any[] = []
let snapshotRows: Any[] = []
const snapshotQueries: Any[] = []
const balanceQueries: Any[] = []

const fakes: Record<string, Any> = {
  user: { findUnique: async () => ownerUser },
  // OWNER → resolveAccessibleCompanyIds 直接回 null（唔查 DB）
  employee: {
    findMany: async () => [
      {
        id: 'e1',
        joinDate: new Date('2025-10-01T00:00:00+08:00'),
        user: { name: 'Ceci' },
        payRules: [],
      },
    ],
  },
  leaveRequest: { findMany: async () => [] },
  leaveBalance: {
    findMany: async (args: Any) => {
      balanceQueries.push(args)
      const sys = args?.where?.leaveType?.systemKey
      if (sys === 'REST_DAY') return restBalanceRows
      return [
        // ANNUAL_LEAVE 累積制 year=0 一行
        { employeeId: 'e1', remaining: 6 },
      ]
    },
  },
  leaveBalanceSnapshot: {
    findMany: async (args: Any) => {
      snapshotQueries.push(args)
      const ids: string[] = args?.where?.employeeId?.in ?? []
      return snapshotRows.filter(
        s => s.periodMonth === args?.where?.periodMonth && ids.includes(s.employeeId),
      )
    },
  },
  hKPublicHoliday: { findMany: async () => [] },
}

const saved: Record<string, Any> = {}

function resetState() {
  restBalanceRows = [
    // 當前 REST_DAY 即時值（跟快照刻意唔同 —— 驗證零 fallback）
    { employeeId: 'e1', remaining: 6.5 },
  ]
  snapshotRows = []
  snapshotQueries.length = 0
  balanceQueries.length = 0
}

before(() => {
  for (const k of Object.keys(fakes)) {
    saved[k] = (prisma as Any)[k]
    Object.defineProperty(prisma, k, { value: fakes[k], configurable: true, writable: true })
  }
})
after(() => {
  for (const k of Object.keys(saved)) {
    Object.defineProperty(prisma, k, { value: saved[k], configurable: true, writable: true })
  }
})

const tok = createToken({ userId: 'u-owner', role: 'OWNER', clinics: [], tokenVersion: 1 })

function getReq(periodMonth: string) {
  return new NextRequest(
    `http://localhost/api/scheduling-leave-summary?companyId=compA&periodMonth=${periodMonth}`,
    { headers: { cookie: `session=${tok}` } },
  )
}

async function fetchRows(periodMonth: string) {
  const res = await GET(getReq(periodMonth))
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.periodMonth, periodMonth)
  assert.equal(body.rows.length, 1)
  return body.rows[0]
}

describe('scheduling-leave-summary — 上月剩 / 剩餘（2026-08-22 §6.2.3）', () => {
  it('#42 九月總覽：上月剩 = 八月快照值（唔係當前值）', async () => {
    resetState()
    snapshotRows = [
      { employeeId: 'e1', leaveTypeId: 'lt-rest', periodMonth: '2026-08', remaining: 7.5 },
    ]

    const row = await fetchRows('2026-09')
    assert.equal(row.lastMonthRestRemaining, 7.5, '上月剩 = 2026-08 快照')
    assert.equal(row.restBalanceRemaining, 6.5, '剩餘 = 當前 REST_DAY 即時值（另一數）')
    assert.notEqual(row.lastMonthRestRemaining, row.restBalanceRemaining, '零 fallback 驗證：兩欄唔同數')

    // snapshot query 用對期 + 對 type
    assert.equal(snapshotQueries[0].where.periodMonth, '2026-08')
    assert.equal(snapshotQueries[0].where.leaveType.systemKey, 'REST_DAY')
  })

  it('#42 跨年：view 2026-01 → 查 snapshot 2025-12', async () => {
    resetState()
    snapshotRows = [
      { employeeId: 'e1', leaveTypeId: 'lt-rest', periodMonth: '2025-12', remaining: 5 },
      // 攞錯期嘅行唔應該攞到（驗證真係 filter 咗）
      { employeeId: 'e1', leaveTypeId: 'lt-rest', periodMonth: '2026-08', remaining: 99 },
    ]

    const row = await fetchRows('2026-01')
    assert.equal(row.lastMonthRestRemaining, 5, '跨年：2026-01 嘅上月 = 2025-12')
    assert.equal(snapshotQueries[0].where.periodMonth, '2025-12')
  })

  it('#38 上月未 finalize 過（snapshot 空）→ 上月剩 = null（唔係 0 / 唔係當前值）', async () => {
    resetState()
    // snapshotRows = []（resetState 已清）

    const row = await fetchRows('2026-09')
    assert.equal(row.lastMonthRestRemaining, null, '無快照 = null（前端顯「—」）')
    assert.notEqual(row.lastMonthRestRemaining, 0, '唔好 fallback 0')
    assert.equal(row.restBalanceRemaining, 6.5, '當前值照常回（唔受影響）')
    assert.equal(snapshotQueries[0].where.periodMonth, '2026-08', '都係查咗上月')
  })

  it('#42b REST_DAY 多曆年 row（上年餘額 + 本年預支）→ 剩餘按員工加總', async () => {
    resetState()
    restBalanceRows = [
      { employeeId: 'e1', remaining: 3 },   // 2025 行：上年未用完
      { employeeId: 'e1', remaining: -1 },  // 2026 行：本月預支
    ]

    const row = await fetchRows('2026-09')
    assert.equal(row.restBalanceRemaining, 2, '3 + (-1) = 2（唔加 year filter，按員工加總）')
    // REST_DAY query 唔應該有 year filter（決定：加總語義）
    const restQuery = balanceQueries.find(q => q?.where?.leaveType?.systemKey === 'REST_DAY')
    assert.ok(restQuery, '有 REST_DAY 查詢')
    assert.equal(restQuery.where.year, undefined, 'REST_DAY 唔加 year filter（理由：上年未用完餘額仍計入真餘額）')
  })

  it('#37 API 回傳齊全部欄（14 欄，含兩新欄）', async () => {
    resetState()
    snapshotRows = [
      { employeeId: 'e1', leaveTypeId: 'lt-rest', periodMonth: '2026-08', remaining: 7.5 },
    ]

    const row = await fetchRows('2026-09')
    const expectedKeys = [
      'employeeId', 'name', 'syStart', 'syEnd', 'entitled', 'usedDays',
      'remainThisYear', 'balanceRemaining', 'inProbation', 'underOneYear',
      'takenDates', 'restQuota', 'restBalanceRemaining', 'lastMonthRestRemaining',
    ]
    for (const k of expectedKeys) {
      assert.ok(k in row, `API 回傳缺欄：${k}`)
    }
    assert.equal(row.employeeId, 'e1')
    assert.equal(row.name, 'Ceci')
  })

  it('#37 頁面 thead 欄序：員工｜上月剩｜R｜PL｜R+PL｜剩餘｜年假（服務年度）', () => {
    const pagePath = path.join(import.meta.dirname, '../app/(protected)/scheduling/page.tsx')
    const src = readFileSync(pagePath, 'utf8')

    // 「上月剩」只係總覽 thead 有 —— 以佢為錨點開 window
    const anchor = src.indexOf('>上月剩</th>')
    assert.ok(anchor > 0, '頁面要有「上月剩」欄')
    const window_ = src.slice(Math.max(0, anchor - 300), anchor + 900)

    const order = ['>員工</th>', '>上月剩</th>', '>R</th>', '>PL</th>', '>R+PL</th>', '>剩餘</th>', '年假（服務年度）']
    let prevIdx = -1
    for (const label of order) {
      const idx = window_.indexOf(label)
      assert.ok(idx > prevIdx, `thead 欄序錯：「${label}」位置唔對`)
      prevIdx = idx
    }
  })
})

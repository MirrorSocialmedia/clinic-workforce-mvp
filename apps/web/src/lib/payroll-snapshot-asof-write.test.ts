/**
 * ★ D 章 — 寫入側 test（cwm-lbsnap-asof-20260909，坑⑥ 守衛）
 * 跑法: npx tsx --test src/lib/payroll-snapshot-asof-write.test.ts
 * （Node 22 內建 test runner）
 *
 * 背景：2026-09-05 cwm-lvsum 修咗**讀取側**（scheduling-leave-summary「剩餘」改用
 *   restDayBalanceAsOf），但**寫入側**（payroll-runs/[id]/route.ts finalize snapshot block）
 *   仍然抄 LeaveBalance.remaining —— 嗰個係【成個曆年嘅滾動值】，已經包含下個月已發放嘅
 *   RESTDAY_GRANT 同已批嘅假期單。八月尾／九月初先確認計糧 → snapshot 攞到「9 月已發、
 *   9 月已放」之後嘅數 → 下月「上月剩」對唔返上月「剩餘」（實測 Jesscia 1→−1、Luna 0→8）。
 *   A 章修法：REST_DAY 改用 restDayBalanceAsOf(tx, snapEmpIds, runMonthEnd) **覆寫** byEmpType。
 *
 * 本檔 = MD D 章「今次 bug 嘅最小重現」（repeatable 自動化 case，唔係手動 e2e）：
 *   1. B 章 dev no-op 斷言：REST_DAY snapshot 月份分佈 = 0 行（dev 乾淨狀態；
 *      生產清錯 snapshot 嘅 DELETE 係老細待辦，唔喺呢度）
 *   2. 造分歧：王護士 2026-09 RESTDAY_GRANT（2 日）+ 已批 2026-09 REST_DAY 單（1 日）
 *      → raw remaining = 9，restDayBalanceAsOf('2026-08-31') = 8（9 ≠ 8 分歧成立）
 *   3. ★★★ finalize 2026-08 run → 寫入嘅 snapshot REST_DAY
 *      **必等於** restDayBalanceAsOf(empIds, '2026-08-31') 且 **唔等於** LeaveBalance.remaining
 *   4. 非 REST_DAY 類型（ANNUAL_LEAVE）照舊抄 —— A 章改動零副作用
 *
 * 點解唔放 scheduling-leave-summary-route.test.ts：嗰份 test infra 係純 fake prisma 單測
 *   （唔連 DB），而寫入側喺 finalize 個 $transaction 入面（snapshotWagesForADW /
 *   computeRosterHours / 多表寫入）—— 現有 infra 唔支援直接測。故照 S1 e2e 腳本模式
 *   （scripts/e2e-lbsnap-s1-20260909.ts，untracked）做 regression 守衛，本檔係佢嘅
 *   **committed node:test 版**（setup→finalize→assert→cleanup 全自動、可 repeat）。
 *
 * 依賴：dev DB 15532 + dev server http://127.0.0.1:3000（DATABASE_URL / JWT_SECRET
 *   讀 .env.local；假設 dev 乾淨基線：王護士 LB 8/0/8、homeClinicId NULL、冇 2026-08 run）。
 *
 * Cleanup：after() 保證跑（包括失敗）—— 清 run/item/snapshot/tbe/leave + 還原
 *   LeaveBalance/homeClinicId + 零殘留 assert。AuditLog append-only 唔清（按設計）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { restDayBalanceAsOf } from './leave-balance-as-of'

// ---- dev env（.env.local 只取 JWT_SECRET）----
// ⚠️ 唔好用 process.env.DATABASE_URL：Prisma runtime 喺 import 階段會 auto-load 本目錄
//   `apps/web/.env`（舊 5432 postgres URL，唔係 15532）污染 env —— 必須用顯式 datasourceUrl。
//   要覆蓋就傳 CWM_TEST_DATABASE_URL（专用，唔會同其他 env 衝突）。
const ENV_LOCAL = path.join(import.meta.dirname, '../../.env.local')
function envLocalVal(key: string): string {
  const raw = fs.readFileSync(ENV_LOCAL, 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.trim() ?? ''
  return raw.replace(/^"|"$/g, '')
}
const DB_URL = process.env.CWM_TEST_DATABASE_URL
  ?? 'postgresql://cw_dev:***@127.0.0.1:15532/clinic_workforce?schema=public'
const JWT_SECRET = envLocalVal('JWT_SECRET')

const prisma = new PrismaClient({ datasourceUrl: DB_URL })
const BASE = 'http://127.0.0.1:3000'

// ---- fixture（同 S1 e2e：seed 王護士，佢有 2026 REST_DAY LeaveBalance 8/0/8）----
const PREFIX = 'E2E LB '
const EMP_ID = 'cmtn52yoz000z3e5o2jc0hpp8' // 王護士
const CLINIC_ID = 'cmtn52yhz00003e5ox8m7sxsj'
const REST_DAY_TYPE = 'cmtn52yp5001g3e5o63rwarbw'
const ANNUAL_TYPE = 'cmtn52yp5001h3e5oc6e0alwa'
const OWNER_ID = 'cmtn52yn0000a3e5ok2zohwln'
const PM = '2026-08'
const PM_DATE = new Date('2026-08-01T00:00:00+08:00')
const AS_OF = '2026-08-31'
const GRANT_ID = 'e2elbgrant00000000000000001'
const LEAVE_ID = 'e2elbleave00000000000000001'
const ORIGINAL_LB = { entitled: 8, used: 0, remaining: 8 }

let runId: string | null = null
let rawRemaining: number | null = null
let asOfRemaining: number | null = null
let annualRemainingBefore: number | null = null

async function api(token: string, method: string, p: string, body?: any) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `session=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json: any = null
  try { json = await res.json() } catch { /* non-json */ }
  return { status: res.status, json }
}

let token = ''

before(async () => {
  const owner = await prisma.user.findUnique({ where: { id: OWNER_ID } })
  if (!owner) throw new Error('seed owner 唔存在')
  token = jwt.sign(
    { userId: owner.id, role: owner.role, clinics: [], tokenVersion: owner.tokenVersion ?? 0 },
    JWT_SECRET,
    { expiresIn: '1d' },
  )

  // dev server 連線檢查（fail 早 = 錯誤訊息清晰）
  try {
    await fetch(`${BASE}/api/healthz`, { signal: AbortSignal.timeout(5000) })
  } catch {
    throw new Error(`dev server ${BASE} 連唔到 —— 起 dev server 先（next dev -p 3000）`)
  }

  // ── 前狀核實（dev 乾淨基線；唔乾淨 = 有殘留，先清）
  const lb0 = await prisma.leaveBalance.findFirst({
    where: { employeeId: EMP_ID, leaveTypeId: REST_DAY_TYPE, year: 2026 },
    select: { entitled: true, used: true, remaining: true },
  })
  assert.ok(
    lb0 && lb0.entitled === ORIGINAL_LB.entitled && lb0.used === ORIGINAL_LB.used && lb0.remaining === ORIGINAL_LB.remaining,
    `前狀：王護士 2026 REST_DAY LB 應該 ${JSON.stringify(ORIGINAL_LB)}（有殘留？先 cleanup）`,
  )
  const hc0 = await prisma.employee.findUnique({ where: { id: EMP_ID }, select: { homeClinicId: true } })
  assert.equal(hc0?.homeClinicId, null, '前狀：homeClinicId 應該 NULL（有殘留？）')
  const staleRuns = await prisma.payrollRun.count({ where: { clinicId: CLINIC_ID, periodMonth: PM_DATE } })
  assert.equal(staleRuns, 0, '前狀：2026-08 run 應該冇（有殘留？先 cleanup）')

  // ── ★ B 章 dev no-op 斷言：REST_DAY snapshot 月份分佈 = 0 行（MD B 章分佈 SQL 同款）
  const restSnapRows = await prisma.leaveBalanceSnapshot.findMany({
    where: { leaveType: { systemKey: 'REST_DAY' } },
    select: { periodMonth: true, remaining: true },
  })
  const byMonth = new Map<string, number>()
  for (const r of restSnapRows) {
    // periodMonth 係 String（"YYYY-MM" periodKey 格式）
    byMonth.set(r.periodMonth, (byMonth.get(r.periodMonth) ?? 0) + 1)
  }
  console.log(`[B章 no-op] REST_DAY snapshot 月份分佈 = ${restSnapRows.length} 行（預期 0）${byMonth.size ? `：${[...byMonth.entries()].map(([m, n]) => `${m}=${n}`).join(', ')}` : ''}`)
  assert.equal(restSnapRows.length, 0, 'B 章 dev no-op：REST_DAY snapshot 應該 0 行（dev 冇嘢清；生產 DELETE 係老細待辦）')

  // ── 造分歧（冪等：先清舊 e2e 行）
  await prisma.timeBankEntry.deleteMany({ where: { id: GRANT_ID } })
  await prisma.leaveRequest.deleteMany({ where: { id: LEAVE_ID } })
  // RESTDAY_GRANT：HK 2026-09-01 00:00（= UTC 2026-08-31T16:00Z，恰過 asOfEnd 15:59:59.999 邊界）。
  // ★ 必用整天（×1440min）—— helper Math.round(minutes/1440)，零頭會被 round 走（S1 教訓）
  await prisma.timeBankEntry.create({
    data: {
      id: GRANT_ID, employeeId: EMP_ID,
      date: new Date('2026-09-01T00:00:00+08:00'),
      type: 'RESTDAY_GRANT', minutes: 2880,
      note: `${PREFIX}RESTDAY_GRANT 2026-09 (2 days × 1440)`,
      createdBy: OWNER_ID,
    },
  })
  // 已批 REST_DAY 假期單：2026-09-10，1 日
  await prisma.leaveRequest.create({
    data: {
      id: LEAVE_ID, employeeId: EMP_ID, leaveTypeId: REST_DAY_TYPE,
      startDate: new Date('2026-09-10T00:00:00+08:00'),
      endDate: new Date('2026-09-10T23:59:59.999+08:00'),
      days: 1, status: 'APPROVED', approverId: OWNER_ID, approvedAt: new Date('2026-09-02T09:00:00+08:00'),
      isPlanned: false, isEmployeeRequested: true, clinicId: CLINIC_ID,
      reason: `${PREFIX}已批 REST_DAY 單（9 月）`,
    },
  })
  // 滾動值（生產語義：9 月 grant 已發放 → entitled+2；9 月假已批 → used+1）
  await prisma.leaveBalance.update({
    where: { employeeId_leaveTypeId_year: { employeeId: EMP_ID, leaveTypeId: REST_DAY_TYPE, year: 2026 } },
    data: { entitled: 10, used: 1, remaining: 9 },
  })
  // generatePayrollRun 按 homeClinicId filter 員工（seed 係 NULL）→ 建 run 前臨時設（S1 教訓）
  await prisma.employee.update({ where: { id: EMP_ID }, data: { homeClinicId: CLINIC_ID } })

  // ── 兩個數直算 + 分歧證明
  const lb1 = await prisma.leaveBalance.findFirst({
    where: { employeeId: EMP_ID, leaveTypeId: REST_DAY_TYPE, year: 2026 },
    select: { remaining: true },
  })
  rawRemaining = lb1!.remaining
  const asOfMap = await restDayBalanceAsOf(prisma, [EMP_ID], AS_OF)
  asOfRemaining = asOfMap.get(EMP_ID)?.remaining ?? null
  annualRemainingBefore = (await prisma.leaveBalance.findFirst({
    where: { employeeId: EMP_ID, leaveTypeId: ANNUAL_TYPE },
    select: { remaining: true },
  }))?.remaining ?? null
  assert.equal(rawRemaining, 9, 'raw remaining 應該 = 9（滾動值含 9 月 grant/假）')
  assert.equal(asOfRemaining, 8, `asOf(2026-08-31) 應該 = 8（entitled 10−2，used 1−1）`)
  assert.notEqual(rawRemaining, asOfRemaining, '★★ 分歧必須成立：raw != asOf')
  console.log(`[D章 分歧] raw_remaining=${rawRemaining}  restDayBalanceAsOf(${AS_OF}).remaining=${asOfRemaining}  → 分歧確認`)
})

describe('D 章 — snapshot 寫入側（坑⑥ 守衛：finalize 抄錯口徑嘅最小重現）', () => {
  it('finalize 2026-08 run → snapshot REST_DAY == restDayBalanceAsOf(2026-08-31) 且 != LeaveBalance.remaining', async () => {
    // 1. POST 建 run（2026-08，王護士所在 clinic）
    const created = await api(token, 'POST', '/api/payroll-runs', { periodMonth: PM, clinicId: CLINIC_ID })
    assert.equal(created.status, 201, `POST /api/payroll-runs 應該 201：${created.status} ${JSON.stringify(created.json)?.slice(0, 200)}`)
    runId = created.json?.runId
    assert.ok(runId, 'runId 攞到')
    const itemEmps = await prisma.payrollItem.findMany({ where: { runId }, select: { employeeId: true } })
    assert.ok(itemEmps.some(i => i.employeeId === EMP_ID), `王護士喺 run items 入面（items=${itemEmps.length}）`)

    // 2. finalize（DRAFT → FINALIZED）
    const fin = await api(token, 'PUT', `/api/payroll-runs/${runId}`, { status: 'FINALIZED' })
    assert.equal(fin.status, 200, `finalize 應該 200：${fin.status} ${JSON.stringify(fin.json)?.slice(0, 200)}`)

    // 3. ★★★ 斷言：snapshot REST_DAY == asOf && != raw
    // ⚠️ LeaveBalanceSnapshot.periodMonth 係 String（"YYYY-MM"）；PayrollRun 先係 DateTime
    const snap = await prisma.leaveBalanceSnapshot.findFirst({
      where: { employeeId: EMP_ID, leaveTypeId: REST_DAY_TYPE, periodMonth: PM },
    })
    assert.ok(snap, 'snapshot 行寫入（REST_DAY, 2026-08）')
    assert.equal(
      snap.remaining, asOfRemaining,
      `★★★ snapshot.remaining 必 = restDayBalanceAsOf(2026-08-31)（snap=${snap?.remaining} asOf=${asOfRemaining}）`,
    )
    assert.notEqual(
      snap.remaining, rawRemaining,
      `★★★ snapshot.remaining 唔 = LeaveBalance.remaining 滾動值（snap=${snap?.remaining} raw=${rawRemaining}）`,
    )
    console.log(`[EVIDENCE★★★] snapshot=${snap.remaining}  asOf(2026-08-31)=${asOfRemaining}  raw=${rawRemaining}  （== asOf 且 != raw）`)

    // 4. 非 REST_DAY 類型照舊抄（A 章改動零副作用）
    const snapAnnual = await prisma.leaveBalanceSnapshot.findFirst({
      where: { employeeId: EMP_ID, leaveTypeId: ANNUAL_TYPE, periodMonth: PM },
    })
    assert.ok(snapAnnual, 'ANNUAL_LEAVE snapshot 行照寫')
    assert.equal(snapAnnual.remaining, annualRemainingBefore, `ANNUAL_LEAVE 照舊抄 raw（=${annualRemainingBefore}）`)
  })
})

after(async () => {
  try {
    // 1. run + items（兜底：變數失咗就按 clinic+PM 搵 —— 前狀已 assert 呢對 combo 冇其他 run）
    let found = runId
      ? await prisma.payrollRun.findUnique({ where: { id: runId } })
      : null
    if (!found) found = await prisma.payrollRun.findFirst({ where: { clinicId: CLINIC_ID, periodMonth: PM_DATE } })
    if (found) {
      await prisma.payrollItem.deleteMany({ where: { runId: found.id } })
      await prisma.payrollRun.delete({ where: { id: found.id } })
      console.log(`[cleanup] run ${found.id} + items`)
    }
    // 2. snapshot（限王護士 + PM；dev 原本 0 行）
    const delSnap = await prisma.leaveBalanceSnapshot.deleteMany({ where: { employeeId: EMP_ID, periodMonth: PM } })
    console.log(`[cleanup] snapshots=${delSnap.count}`)
    // 3. TimeBankEntry：e2e grant + ROSTER_DIFF + prefix 行
    const delTbe = await prisma.timeBankEntry.deleteMany({
      where: {
        OR: [
          { id: GRANT_ID },
          { employeeId: EMP_ID, type: 'ROSTER_DIFF' },
          { note: { startsWith: PREFIX } },
        ],
      },
    })
    console.log(`[cleanup] TimeBankEntry=${delTbe.count}`)
    // 4. LeaveRequest
    await prisma.leaveRequest.deleteMany({ where: { id: LEAVE_ID } })
    // 5. 還原 LeaveBalance + homeClinicId
    await prisma.leaveBalance.update({
      where: { employeeId_leaveTypeId_year: { employeeId: EMP_ID, leaveTypeId: REST_DAY_TYPE, year: 2026 } },
      data: ORIGINAL_LB,
    })
    await prisma.employee.update({ where: { id: EMP_ID }, data: { homeClinicId: null } })

    // ── 零殘留 assert（限呢個 e2e 嘅 footprint + B 章 no-op 狀態）
    const lbC = await prisma.leaveBalance.findFirst({
      where: { employeeId: EMP_ID, leaveTypeId: REST_DAY_TYPE, year: 2026 },
      select: { entitled: true, used: true, remaining: true },
    })
    assert.equal(
      `${lbC?.entitled}/${lbC?.used}/${lbC?.remaining}`,
      `${ORIGINAL_LB.entitled}/${ORIGINAL_LB.used}/${ORIGINAL_LB.remaining}`,
      'LeaveBalance 還原 8/0/8',
    )
    assert.equal(
      (await prisma.employee.findUnique({ where: { id: EMP_ID }, select: { homeClinicId: true } }))?.homeClinicId,
      null, 'homeClinicId 還原 NULL',
    )
    assert.equal(
      await prisma.payrollRun.count({ where: { clinicId: CLINIC_ID, periodMonth: PM_DATE } }),
      0, '2026-08 run 清晒',
    )
    assert.equal(
      await prisma.timeBankEntry.count({
        where: {
          OR: [
            { id: GRANT_ID },
            { employeeId: EMP_ID, type: 'ROSTER_DIFF' },
            { note: { startsWith: PREFIX } },
          ],
        },
      }),
      0, 'e2e TimeBankEntry 清晒',
    )
    assert.equal(await prisma.leaveRequest.count({ where: { id: LEAVE_ID } }), 0, 'e2e LeaveRequest 清晒')
    const restSnapLeft = await prisma.leaveBalanceSnapshot.count({ where: { leaveType: { systemKey: 'REST_DAY' } } })
    assert.equal(restSnapLeft, 0, '★★ B 章 no-op 狀態回復：REST_DAY snapshot = 0 行')
    console.log('[cleanup] 零殘留 ✔（LB 8/0/8、homeClinicId NULL、run/tbe/leave/snapshot 清晒）')
  } finally {
    await prisma.$disconnect()
  }
})

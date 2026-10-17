// ============================================================
// ★ cwm-payadj-20261017 ②：計糧調整 —— 真 Postgres 對抗式測試（MD §2.7）
// 跑法: CWM_TEST_DATABASE_URL=postgres://… TZ=UTC npx tsx --test src/lib/payroll/adjustments-db.test.ts
//
//   直接行 production route handler（4 條 adjustments route + finalize gate），
//   用自己嘅 fixture（e2epa- 前綴：OWNER + MANAGER user、1 普通員工、1 保密員工、
//   2031-09 遠未來月份 DRAFT run），after() 必清 + 零殘留 assert。
//   AuditLog append-only（trigger 擋刪）→ 審計行同 fixture user 會留低（同 e2etm- 一樣，按設計）。
//   ⚠️ tsx 跑 CJS：prisma 要喺 DATABASE_URL 設定之後先 import（.env auto-load 陷阱），全部 import 入 before()。
//
// 覆蓋 MD §2.7：
//   · CRUD（POST / GET / PUT / DELETE 軟刪）
//   · FINALIZED 月份 409
//   · 重新生成草稿之後調整仲喺度、數啱
//   · 改咗調整但未重算 → finalize 409 PAYROLL_ADJ_STALE
//   · 會令實發變負 → 400，DB 還原（冇殘留行）
//   · MANAGER 對保密員工 → 403
// ============================================================
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { NextRequest } from 'next/server'

const P = 'e2epa' // cleanup startWith 前綴
// ⚠️ requireAuth.normalizeRoute 只認 cuid 形（[a-z0-9]{20,}）做 :id — 短/hyphen id → 403 route not registered
const OWNER_USER = `${P}ownr00000000000001`
const MANAGER_USER = `${P}mngr00000000000001`
const USER2 = `${P}user20000000000001` // Employee.userId unique → 第二個員工要自己個 user
const EMP = `${P}emp100000000000001`
const EMP_CONF = `${P}emp20000000000001`
const MONTH = '2031-09' // 遠未來月份，唔會撞真數據（⚠️ 2031-07 俾 timebank-manual-db 用緊 — tsx --test 並行跑，同月 clinicId=null run 撞 partial unique payroll_run_all_clinics）
const RUN_ID = `${P}run000000000000001`
let RUN_ITEM_EMP: string
let RUN_ITEM_CONF: string

let db: any
let GET_ADJ: any
let POST_ADJ: any
let PUT_ADJ: any
let DELETE_ADJ: any
let PUT_RUN: any
let POST_SINGLE: any
let createToken: any
let tokOwner: string
let tokManager: string
let dbDown = false

async function cleanup() {
  // 順序跟 FK：Adjustment → Item → Run → PayRule → TimeBank
  await db.payrollAdjustment.deleteMany({ where: { employeeId: { in: [EMP, EMP_CONF] } } }).catch(() => {})
  await db.payrollItem.deleteMany({ where: { employeeId: { in: [EMP, EMP_CONF] } } })
  await db.payrollRun.deleteMany({ where: { id: { startsWith: P } } })
  await db.timeBankEntry.deleteMany({ where: { employeeId: { in: [EMP, EMP_CONF] } } })
  await db.timeBank.deleteMany({ where: { employeeId: { in: [EMP, EMP_CONF] } } })
  await db.payRule.deleteMany({ where: { employeeId: { in: [EMP, EMP_CONF] } } })
  // ★ Employee／User 刻意唔刪（AuditLog append-only trigger → 同 e2etm- 註）
}

before(async () => {
  process.env.DATABASE_URL = process.env.CWM_TEST_DATABASE_URL ?? 'postgresql://cw_dev:***@127.0.0.1:15532/clinic_workforce?schema=public'
  const [pm, gAdj, pAdj, uAdj, dAdj, pRun, pSingle, auth] = await Promise.all([
    import('@/lib/prisma'),
    import('../../app/api/payroll-runs/[id]/employee/[empId]/adjustments/route'),
    import('../../app/api/payroll-runs/[id]/employee/[empId]/adjustments/route'),
    import('../../app/api/payroll-runs/[id]/employee/[empId]/adjustments/[adjId]/route'),
    import('../../app/api/payroll-runs/[id]/employee/[empId]/adjustments/[adjId]/route'),
    import('../../app/api/payroll-runs/[id]/route'),
    import('../../app/api/payroll-runs/[id]/employee/[empId]/route'),
    import('../auth'),
  ])
  db = pm.basePrisma
  GET_ADJ = gAdj.GET
  POST_ADJ = pAdj.POST
  PUT_ADJ = uAdj.PUT
  DELETE_ADJ = dAdj.DELETE
  PUT_RUN = pRun.PUT
  POST_SINGLE = pSingle.POST
  createToken = auth.createToken
  tokOwner = createToken({ userId: OWNER_USER, role: 'OWNER', clinics: [], tokenVersion: 1 })
  tokManager = createToken({ userId: MANAGER_USER, role: 'MANAGER', clinics: [], tokenVersion: 1 })
  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    dbDown = true
    return
  }
  await cleanup()
  for (const u of [
    { id: OWNER_USER, name: 'E2E 計糧調整 owner', phone: '90001001-e2epa', role: 'OWNER' },
    { id: MANAGER_USER, name: 'E2E 計糧調整 mgr', phone: '90001002-e2epa', role: 'MANAGER' },
    { id: USER2, name: 'E2E 計糧調整 u2', phone: '90001003-e2epa', role: 'EMPLOYEE' },
  ]) {
    await db.user.upsert({ where: { id: u.id }, create: { ...u, password: 'x', tokenVersion: 1 }, update: { role: u.role, tokenVersion: 1 } })
  }
  for (const [id, conf, uid] of [[EMP, false, OWNER_USER], [EMP_CONF, true, USER2]] as const) {
    await db.employee.upsert({
      where: { id },
      create: { id, userId: uid, joinDate: new Date('2026-01-05T00:00:00Z'), payConfidential: conf, homeClinicId: null },
      update: { userId: uid, payConfidential: conf, homeClinicId: null },
    })
    await db.payRule.create({
      data: {
        employeeId: id, payType: 'MONTHLY', baseAmount: 15000,
        configJson: JSON.stringify({ base_type: 'monthly', monthly_salary: 15000 }),
        effectiveFrom: new Date('2026-01-01T00:00:00Z'), createdBy: OWNER_USER,
      },
    })
  }
  const run = await db.payrollRun.create({
    data: { id: RUN_ID, clinicId: null, periodMonth: new Date(`${MONTH}-01T00:00:00+08:00`), status: 'DRAFT' },
  })
  const i1 = await db.payrollItem.create({ data: { id: `${P}item100000000000001`, runId: run.id, employeeId: EMP } })
  const i2 = await db.payrollItem.create({ data: { id: `${P}item200000000000001`, runId: run.id, employeeId: EMP_CONF } })
  RUN_ITEM_EMP = i1.id
  RUN_ITEM_CONF = i2.id
})

after(async () => {
  if (!dbDown && db) {
    await cleanup()
    const left = await Promise.all([
      db.payrollAdjustment.count({ where: { employeeId: { in: [EMP, EMP_CONF] } } }),
      db.payrollItem.count({ where: { runId: { startsWith: P } } }),
      db.payrollRun.count({ where: { id: { startsWith: P } } }),
      db.payRule.count({ where: { employeeId: { in: [EMP, EMP_CONF] } } }),
      db.timeBank.count({ where: { employeeId: { in: [EMP, EMP_CONF] } } }),
    ])
    assert.deepEqual(left, [0, 0, 0, 0, 0], '零殘留')
  }
  await db?.$disconnect()
})

const req = (method: string, path: string, body?: any, tok?: string) =>
  new NextRequest(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie: `session=${tok ?? tokOwner}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

// 直接 call route handler（非 Next 運行）→ 要手傳 { params }（同 timebank test 嘅 query 版本不同）
const ctxAdj = (empId: string) => ({ params: { id: RUN_ID, empId } })
const ctxAdjId = (empId: string, adjId: string) => ({ params: { id: RUN_ID, empId, adjId } })

const json = async (res: any) => ({ status: res.status, body: await res.json().catch(() => ({})) })

const liveHash = async (empId: string) => {
  const rows = await db.payrollAdjustment.findMany({ where: { employeeId: empId, periodMonth: MONTH, deletedAt: null } })
  const { adjHashOf } = await import('./adjustments')
  return adjHashOf(rows.map((r: any) => ({ id: r.id, amount: Number(r.amount), mpfTiming: r.mpfTiming, reason: r.reason })))
}

const itemDetail = async (empId: string) => {
  const it = await db.payrollItem.findFirst({ where: { runId: RUN_ID, employeeId: empId } })
  return JSON.parse(it?.detailJson ?? '{}')
}

// ────────────────────────────────────────────────────────────
test('CRUD：POST 兩行 → GET 列返；detail 同步（adjPreMpf/adjPostMpf/adjHash）', { skip: dbDown }, async () => {
  const r1 = await json(await POST_ADJ(req('POST', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`, {
    amount: 500, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'e2e 補差額',
  }), ctxAdj(EMP)))
  assert.equal(r1.status, 200, JSON.stringify(r1))
  const r2 = await json(await POST_ADJ(req('POST', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`, {
    amount: 1000, sign: 'DEDUCT', mpfTiming: 'POST_MPF', reason: 'e2e 預支',
  }), ctxAdj(EMP)))
  assert.equal(r2.status, 200, JSON.stringify(r2))

  const g = await json(await GET_ADJ(req('GET', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`), ctxAdj(EMP)))
  assert.equal(g.status, 200)
  assert.equal(g.body.adjustments.length, 2, JSON.stringify(g.body))
  assert.equal(g.body.adjStale, false, '剛重算完 → 唔係 stale')
  assert.equal(g.body.sum.pre, 500)
  assert.equal(g.body.sum.post, -1000)

  const d = await itemDetail(EMP)
  assert.equal(d.adjPreMpf, 500, 'detail.adjPreMpf 同步')
  assert.equal(d.adjPostMpf, -1000, 'detail.adjPostMpf 同步')
  assert.equal(d.adjHash, await liveHash(EMP), 'detail.adjHash = live hash')
  assert.equal(d.adjustments.length, 2, 'detail.adjustments 逐行')
  // 數字：底薪 15,000 + 500(前) = gross 15,500（無 MPF — 無 clinic config）；MPF 後 −1,000 → 14,500
  assert.equal(d.grossPay, 15500, `gross 應 15,500（得到 ${d.grossPay}）`)
  assert.equal(d.netPay, 14500, `net 應 14,500（得到 ${d.netPay}）`)
})

test('CRUD：PUT 改一行 → 数字 + hash 同步', { skip: dbDown }, async () => {
  const g = await json(await GET_ADJ(req('GET', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`), ctxAdj(EMP)))
  const target = g.body.adjustments.find((a: any) => a.mpfTiming === 'POST_MPF')
  const r = await json(await PUT_ADJ(req('PUT', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments/${target.id}`, {
    amount: 200, sign: 'DEDUCT', mpfTiming: 'POST_MPF', reason: 'e2e 改少啲',
  }), ctxAdjId(EMP, target.id)))
  assert.equal(r.status, 200, JSON.stringify(r))
  const d = await itemDetail(EMP)
  assert.equal(d.adjPostMpf, -200)
  assert.equal(d.netPay, 15300, 'gross 15,500 − 200 = 15,300')
  assert.equal(d.adjHash, await liveHash(EMP))
})

test('CRUD：DELETE 軟刪 → 行消失、hash 同步、DB 有 deletedAt', { skip: dbDown }, async () => {
  const g = await json(await GET_ADJ(req('GET', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`), ctxAdj(EMP)))
  const target = g.body.adjustments.find((a: any) => a.mpfTiming === 'PRE_MPF')
  const r = await json(await DELETE_ADJ(req('DELETE', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments/${target.id}`), ctxAdjId(EMP, target.id)))
  assert.equal(r.status, 200, JSON.stringify(r))
  assert.equal(r.body.deleted, true)
  const row = await db.payrollAdjustment.findUnique({ where: { id: target.id } })
  assert.ok(row.deletedAt, '軟刪：deletedAt 有值（審計睇得返）')
  const d = await itemDetail(EMP)
  assert.equal(d.adjPreMpf, 0)
  assert.equal(d.adjHash, await liveHash(EMP), '重算後 hash = live（剩一行的 hash）')
})

test('FINALIZED 月份 → POST 409 NOT_DRAFT', { skip: dbDown }, async () => {
  await db.payrollRun.update({ where: { id: RUN_ID }, data: { status: 'FINALIZED' } })
  try {
    const r = await json(await POST_ADJ(req('POST', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`, {
      amount: 100, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'e2e 已確認',
    }), ctxAdj(EMP)))
    assert.equal(r.status, 409, JSON.stringify(r))
    assert.equal(r.body.code, 'NOT_DRAFT')
  } finally {
    await db.payrollRun.update({ where: { id: RUN_ID }, data: { status: 'DRAFT' } })
  }
})

test('重新生成草稿 → 調整仲喺度、數啱（唔掛 PayrollItem）', { skip: dbDown }, async () => {
  // 清空 → 加兩行 → 用「單個員工重算」（generatePayrollRun onlyEmployeeIds）重寫 item
  const g0 = await json(await GET_ADJ(req('GET', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`), ctxAdj(EMP)))
  for (const a of g0.body.adjustments) {
    await DELETE_ADJ(req('DELETE', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments/${a.id}`), ctxAdjId(EMP, a.id))
  }
  await POST_ADJ(req('POST', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`, { amount: 500, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'e2e 保留 A' }), ctxAdj(EMP))
  await POST_ADJ(req('POST', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`, { amount: 1000, sign: 'DEDUCT', mpfTiming: 'POST_MPF', reason: 'e2e 保留 B' }), ctxAdj(EMP))

  const r = await json(await POST_SINGLE(req('POST', `/api/payroll-runs/${RUN_ID}/employee/${EMP}`, {}), ctxAdj(EMP)))
  assert.equal(r.status, 200, JSON.stringify(r))

  const g = await json(await GET_ADJ(req('GET', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`), ctxAdj(EMP)))
  assert.equal(g.body.adjustments.length, 2, '重新生成之後調整仲喺')
  const d = await itemDetail(EMP)
  assert.equal(d.adjPreMpf, 500, '重寫後數啱（PRE）')
  assert.equal(d.adjPostMpf, -1000, '重寫後數啱（POST）')
  assert.equal(d.adjHash, await liveHash(EMP))
})

test('stale：改咗調整但未重算 → finalize 409 PAYROLL_ADJ_STALE', { skip: dbDown }, async () => {
  // 模擬「重算失敗／手改」：直接改 DB 行（唔經 API）→ detail.adjHash 變 stale
  const row = (await db.payrollAdjustment.findMany({ where: { employeeId: EMP, periodMonth: MONTH, deletedAt: null } }))[0]
  await db.payrollAdjustment.update({ where: { id: row.id }, data: { amount: -1 } })

  const r = await json(await PUT_RUN(req('PUT', `/api/payroll-runs/${RUN_ID}`, { status: 'FINALIZED' }), { params: { id: RUN_ID } }))
  assert.equal(r.status, 409, JSON.stringify(r))
  assert.equal(r.body.code, 'PAYROLL_ADJ_STALE', 'finalize gate 擋')

  // 重算返 → hash 同步 → finalize 應該過（呢度只驗 gate 解除）
  await POST_SINGLE(req('POST', `/api/payroll-runs/${RUN_ID}/employee/${EMP}`, {}), ctxAdj(EMP))
  await POST_SINGLE(req('POST', `/api/payroll-runs/${RUN_ID}/employee/${EMP_CONF}`, {}), ctxAdj(EMP_CONF)) // fixture 第二行 detail 係空 → 一併重算
  const r2 = await json(await PUT_RUN(req('PUT', `/api/payroll-runs/${RUN_ID}`, { status: 'FINALIZED' }), { params: { id: RUN_ID } }))
  assert.equal(r2.status, 200, `重算後 finalize 應過：${JSON.stringify(r2)}`)
  // 還返 DRAFT 畀之後 test
  await db.payrollRun.update({ where: { id: RUN_ID }, data: { status: 'DRAFT' } })
})

test('實發會變負 → 400，DB 還原（冇殘留行）', { skip: dbDown }, async () => {
  const before = await db.payrollAdjustment.count({ where: { employeeId: EMP, periodMonth: MONTH, deletedAt: null } })
  const r = await json(await POST_ADJ(req('POST', `/api/payroll-runs/${RUN_ID}/employee/${EMP}/adjustments`, {
    amount: 20000, sign: 'DEDUCT', mpfTiming: 'POST_MPF', reason: 'e2e 爆負數',
  }), ctxAdj(EMP)))
  assert.equal(r.status, 400, JSON.stringify(r))
  assert.equal(r.body.code, 'NET_WOULD_BE_NEGATIVE')
  const after = await db.payrollAdjustment.count({ where: { employeeId: EMP, periodMonth: MONTH, deletedAt: null } })
  assert.equal(after, before, 'DB 還原：冇新增 live 行')
  // 已生成嘅行（軟刪）都要冇
  const created = await db.payrollAdjustment.findFirst({ where: { employeeId: EMP, reason: 'e2e 爆負數' } })
  assert.ok(!created || created.deletedAt, '若曾有行 → 必軟刪')
})

test('MANAGER 對保密員工 → 403（GET + POST）；OWNER 照入', { skip: dbDown }, async () => {
  const gM = await json(await GET_ADJ(req('GET', `/api/payroll-runs/${RUN_ID}/employee/${EMP_CONF}/adjustments`, undefined, tokManager), ctxAdj(EMP_CONF)))
  assert.equal(gM.status, 403, `MANAGER GET 保密員工應 403（得到 ${gM.status}）`)
  const pM = await json(await POST_ADJ(req('POST', `/api/payroll-runs/${RUN_ID}/employee/${EMP_CONF}/adjustments`, {
    amount: 100, sign: 'ADD', mpfTiming: 'PRE_MPF', reason: 'e2e mgr 試',
  }, tokManager), ctxAdj(EMP_CONF)))
  assert.equal(pM.status, 403)
  const gO = await json(await GET_ADJ(req('GET', `/api/payroll-runs/${RUN_ID}/employee/${EMP_CONF}/adjustments`, undefined, tokOwner), ctxAdj(EMP_CONF)))
  assert.equal(gO.status, 200, `OWNER 照入（得到 ${gO.status}）`)
  assert.equal(gO.body.adjustments.length, 0)
})

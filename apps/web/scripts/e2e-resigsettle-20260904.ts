/**
 * ★ cwm-resigsettle-20260904 驗收 e2e（commit 保留 — 回歸用）。
 * 離職結算 EO 合規：T1 prorata 統一 / T2 離職取消假期還額度 / T3 結算單 / CANCELLED 過濾。
 *
 * 自包含：e2ers<epoch> 前綴 fixture（cuid 形 id — normalizeRoute 要 20+ lowercase alnum）；
 *        結束時逐表 sweep 核對 = 0（AuditLog append-only trigger — 保留，informational）。
 *
 * 跑法: cd apps/web && set -a && . ./.env.development && set +a && npx tsx scripts/e2e-resigsettle-20260904.ts
 * 預期：FAIL=0（必跑十格 #1 #2 #5 #8 #9 #13 #14 #15 #16 #20 全部涵蓋 + #3 #6 #7 #10 #11 #12 #17 #18 #19）
 * 注意：in-process 直調 route handler（唔使 dev server；JWT 用 in-process secret，同 process 一致）。
 *       #4 文案 = fs 斷言三頁字串。#21 計糧 = [code]（payroll engine 讀 LeaveBalance，無 code 改動）。
 */
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import fs from 'node:fs'
import path from 'node:path'
import { createToken } from '../src/lib/auth'
import { hkDateStart, toHKDateStr } from '../src/lib/hk-date'
import { totalAccruedLeave } from '../src/lib/leave-calculation'
import { POST as refreshPost } from '../src/app/api/leave-balance/refresh/route'
import { PUT as accountsPut } from '../src/app/api/accounts/[id]/route'
import { GET as shiftsGet } from '../src/app/api/shifts/route'
import { GET as previewGet } from '../src/app/api/employees/[id]/resign-preview/route'
import { POST as resignPost } from '../src/app/api/employees/[id]/resign/route'

const prisma = new PrismaClient()
const S = String(Math.floor(Date.now() / 1000))

// cuid 形 id（20+ lowercase alnum — normalizeRoute 會將 hyphen id 判做 route 參 → 403）
let CL_A = '', CL_B = ''
let tmplId = ''
const E = (suf: string) => `e2ers${S}${suf}` // 20+ chars: e2ers(5)+10+suf(≥5)

let pass = 0, fail = 0
const failures: string[] = []
function check(id: string, cond: boolean, evidence: string) {
  if (cond) { pass++; console.log(`  ✅ ${id}: ${evidence}`) }
  else { fail++; failures.push(`${id}: ${evidence}`); console.log(`  ❌ ${id}: ${evidence}`) }
}
function near(a: number, b: number, tol = 0.02) { return Math.abs(a - b) <= tol }
setTimeout(() => { console.error('TIMEOUT 6min — 強制結束'); process.exit(2) }, 6 * 60 * 1000).unref()

// ─── request helper（cookie session=<jwt>，同 require-auth 取 token 方式一致）──
let OWNER_TOKEN = ''
function mkReq(pathStr: string, opts: { method?: string; body?: any } = {}) {
  const headers: Record<string, string> = { 'cookie': `session=${OWNER_TOKEN}` }
  if (opts.body) headers['content-type'] = 'application/json'
  return new NextRequest(`http://localhost:3000${pathStr}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

// ─── fixture 場景（MD §零）────────────────────────────────────────
// A = CC2 形：服務 8 個月（2025-12-31 入職）、月薪 17000、年假 4.7 形、時間帳戶 −2394 分、未來已批假期
// B = Selina 形：服務 1 個月（2026-07-31 入職）、年假 0 日、時間帳戶 −80 分、未來已批假期
// C = 1 年半（2025-03-01 入職）：prorata > earned 驗證
// D = 整 2 年（今日 −2 年）：prorata 唔會多計（週年日）
const JOIN_A = new Date('2025-12-31T00:00:00+08:00')
const JOIN_B = new Date('2026-07-31T00:00:00+08:00')
const JOIN_C = new Date('2025-03-01T00:00:00+08:00')
const now = new Date()
const todayStr = toHKDateStr(now)
const [ty, tm, td] = todayStr.split('-').map(Number)
const JOIN_D = new Date(Date.UTC(ty - 2, tm - 1, td)) // 整 2 年（HK wall-clock 同日）

const LAST_DAY_A = '2026-09-30' // A 做足 9 月（MD §零）
const LAST_DAY_B = '2026-09-08' // B 9 月 8 日走（MD §八 #8 場景）


async function mkUser(name: string, phone: string) {
  return prisma.user.create({ data: { name, phone, password: 'x'.repeat(60), status: 'ACTIVE', role: 'EMPLOYEE' } })
}
async function mkEmp(uid: string, joinDate: Date, clinicId: string) {
  const e = await prisma.employee.create({ data: { userId: uid, joinDate, status: 'ACTIVE', homeClinicId: clinicId } })
  await prisma.employeeClinic.create({ data: { employeeId: e.id, clinicId, isPrimary: true } })
  return e
}
const sh = (d: string, h1: number, h2: number) => ({
  date: new Date(`${d}T00:00:00+08:00`),
  startTime: new Date(`${d}T${String(h1).padStart(2, '0')}:00:00+08:00`),
  endTime: new Date(`${d}T${String(h2).padStart(2, '0')}:00:00+08:00`),
})

async function main() {
  console.log('── lookup seeds ──')
  // ★ seed 6 間店 createdAt 同一毫秒 → orderBy createdAt 唔穩定（CL_A===CL_B 會 unique violation），用 id 排
  const clinics2 = await prisma.clinic.findMany({ orderBy: { id: 'asc' }, take: 2 })
  CL_A = clinics2[0].id
  CL_B = clinics2[1].id
  const owner = await prisma.user.findFirst({ where: { email: 'owner@clinic.demo' } })
  if (!owner) { console.error('seed owner 唔存在（email owner@clinic.demo）'); process.exit(1) }
  tmplId = (await prisma.shiftTemplate.findFirst({ where: { name: '全日' } }))!.id
  OWNER_TOKEN = createToken({ userId: owner.id, role: owner.role, clinics: [], tokenVersion: owner.tokenVersion ?? 0 })
  const LT: Record<string, string> = {}
  for (const k of ['ANNUAL_LEAVE', 'REST_DAY']) {
    const t = await prisma.leaveType.findUnique({ where: { systemKey: k } })
    if (!t) { console.error(`LeaveType ${k} 唔存在`); process.exit(1) }
    LT[k] = t.id
  }

  console.log('── seed fixtures ──')
  const uA = await mkUser('E2E RS EmpA', `e2ers${S}a1`)
  const uB = await mkUser('E2E RS EmpB', `e2ers${S}b1`)
  const uC = await mkUser('E2E RS EmpC', `e2ers${S}c1`)
  const uD = await mkUser('E2E RS EmpD', `e2ers${S}d1`)
  const eA = await mkEmp(uA.id, JOIN_A, CL_A)
  const eB = await mkEmp(uB.id, JOIN_B, CL_A)
  const eC = await mkEmp(uC.id, JOIN_C, CL_B)
  const eD = await mkEmp(uD.id, JOIN_D, CL_B)

  // A：月薪 17000 PayRule + 10 個月 WageHistory（ADW 真路徑）
  await prisma.payRule.create({ data: {
    employeeId: eA.id, payType: 'MONTHLY', baseAmount: 17000,
    configJson: JSON.stringify({ monthly_salary: 17000, ot_threshold: 18 }),
    effectiveFrom: JOIN_A, isActive: true, createdBy: owner.id,
  } })
  const months: string[] = []
  for (let i = 9; i >= 0; i--) {
    const d = new Date(Date.UTC(ty, tm - 1 - i, 1))
    months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  // 2025-12 .. 2026-09（10 個月，每月 17000 / 30 日 → ADW = 566.67）
  await prisma.wageHistory.createMany({ data: months.map(pm => ({
    id: E(`wh${pm.replace('-', '')}`), employeeId: eA.id, periodMonth: pm,
    totalWage: 17000, excludedDays: 0, excludedWage: 0, calendarDays: 30, createdBy: owner.id,
  })) })

  // A：過去已批年假 2 日（< cutoff）+ 未來已批年假 2 日（> cutoff 2026-09-30）
  await prisma.leaveRequest.create({ data: {
    employeeId: eA.id, leaveTypeId: LT.ANNUAL_LEAVE,
    startDate: new Date('2026-06-10T00:00:00+08:00'), endDate: new Date('2026-06-11T00:00:00+08:00'),
    days: 2, status: 'APPROVED', approverId: owner.id, approvedAt: new Date('2026-06-01T00:00:00+08:00'),
  } })
  await prisma.leaveRequest.create({ data: {
    employeeId: eA.id, leaveTypeId: LT.ANNUAL_LEAVE,
    startDate: new Date('2026-10-05T00:00:00+08:00'), endDate: new Date('2026-10-06T00:00:00+08:00'),
    days: 2, status: 'APPROVED', approverId: owner.id, approvedAt: new Date('2026-09-01T00:00:00+08:00'),
  } })
  // A：REST_DAY 額度（§4.3 形：entitled 18 / used 19 / remaining −1）—— 驗證結算單唔顯示
  await prisma.leaveBalance.create({ data: {
    employeeId: eA.id, leaveTypeId: LT.REST_DAY, year: ty, entitled: 18, used: 19, remaining: -1,
  } })
  // A：未來 3 更（10/1..10/3，> cutoff）
  for (const d of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    const t = sh(d, 9, 18)
    await prisma.shift.create({ data: { employeeId: eA.id, clinicId: CL_A, templateId: tmplId, status: 'CONFIRMED', createdBy: owner.id, ...t } })
  }
  // A：時間帳戶 −2394 分（INIT_ADJUST −2515 + OT +121）
  await prisma.timeBank.create({ data: { employeeId: eA.id, periodMonth: new Date('2026-08-01T00:00:00+08:00'), balance: -2394, carriedFrom: 0 } })
  await prisma.timeBankEntry.createMany({ data: [
    { id: E('tbinit01'), employeeId: eA.id, date: new Date('2026-01-02T00:00:00+08:00'), type: 'INIT_ADJUST', minutes: -2515, note: '初始化調整（裝修期間無薪假但照出全糧）' },
    { id: E('tbplus01'), employeeId: eA.id, date: new Date('2026-02-01T00:00:00+08:00'), type: 'OT', minutes: 121 },
  ] })
  // A：人臉模板（#11）
  await prisma.faceTemplate.create({ data: {
    employeeId: eA.id, embedding: '[0.1,0.2,0.3]', active: true, enrolledBy: owner.id,
    consentAt: new Date('2026-01-02T00:00:00+08:00'), consentVersion: '1.0',
  } })

  // B：未來已批年假 1 日（9/15 > cutoff 9/8）+ 時間帳戶 −80 分（MAKEUP）
  await prisma.leaveRequest.create({ data: {
    employeeId: eB.id, leaveTypeId: LT.ANNUAL_LEAVE,
    startDate: new Date('2026-09-15T00:00:00+08:00'), endDate: new Date('2026-09-15T00:00:00+08:00'),
    days: 1, status: 'APPROVED', approverId: owner.id, approvedAt: new Date('2026-09-01T00:00:00+08:00'),
  } })
  await prisma.timeBank.create({ data: { employeeId: eB.id, periodMonth: new Date('2026-08-01T00:00:00+08:00'), balance: -80, carriedFrom: 0 } })
  await prisma.timeBankEntry.create({ data: { id: E('tbmkup01'), employeeId: eB.id, date: new Date('2026-08-20T00:00:00+08:00'), type: 'MAKEUP', minutes: -80, note: '補鐘' } })

  console.log('── #1 自動計算年假額度（refresh 全部在職）──')
  const rRefresh = await refreshPost(mkReq('/api/leave-balance/refresh', { method: 'POST', body: {} }))
  const jRefresh = await rRefresh.json()
  check('#1a refresh 200', rRefresh.status === 200, `refresh status=${rRefresh.status} body=${JSON.stringify(jRefresh).slice(0, 140)}`)
  const balA1 = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: eA.id, leaveTypeId: LT.ANNUAL_LEAVE, year: 0 } } })
  const balB1 = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: eB.id, leaveTypeId: LT.ANNUAL_LEAVE, year: 0 } } })
  const balC1 = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: eC.id, leaveTypeId: LT.ANNUAL_LEAVE, year: 0 } } })
  const balD1 = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: eD.id, leaveTypeId: LT.ANNUAL_LEAVE, year: 0 } } })
  check('#1b A entitled 4.74', !!balA1 && near(balA1.entitled, 4.74), `A.entitled=${balA1?.entitled}`)
  check('#1c B(Selina) entitled 0', !!balB1 && near(balB1.entitled, 0), `B.entitled=${balB1?.entitled}`)
  check('#5a C prorata 10.59 > earned 7', !!balC1 && near(balC1.entitled, 10.59), `C.entitled=${balC1?.entitled} (earned=7, diff=3.59=進行中年度 7×187/365)`)
  check('#5b D 整2年 唔多計 = 14', !!balD1 && near(balD1.entitled, 14), `D.entitled=${balD1?.entitled} (prorata diff vs earned = 0)`)
  check('#20 在職員工口徑', !!balC1 && !!balD1 && near(balC1.entitled, 10.59) && near(balD1.entitled, 14), '服務未夠1年(進中年度)由0變非0；滿整年者不變 — 與 lib 對數一致')

  // 模擬「已批假期消費額度」：A used=4（過去2+未來2），B used=1（未來1）
  await prisma.leaveBalance.update({ where: { id: balA1!.id }, data: { used: 4, remaining: balA1!.entitled - 4 } })
  await prisma.leaveBalance.update({ where: { id: balB1!.id }, data: { used: 1, remaining: balB1!.entitled - 1 } })

  console.log('── #2 帳號管理改欄儲存（帶 joinDate）唔好覆蓋 ──')
  const rAcc1 = await accountsPut(mkReq(`/api/accounts/${uA.id}`, { method: 'PUT', body: { joinDate: '2025-12-31', phone: uA.phone } }), { params: { id: uA.id } })
  const balA2 = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: eA.id, leaveTypeId: LT.ANNUAL_LEAVE, year: 0 } } })
  check('#2 改欄+joinDate 儲存 → 仍然 4.74', rAcc1.status === 200 && !!balA2 && near(balA2.entitled, 4.74), `status=${rAcc1.status} A.entitled=${balA2?.entitled}（舊 earned 口径會係 0）`)

  console.log('── #3 改主屬店（form 帶住 joinDate）──')
  const rAcc2 = await accountsPut(mkReq(`/api/accounts/${uA.id}`, { method: 'PUT', body: { joinDate: '2025-12-31', clinicIds: [CL_A, CL_B], homeClinicId: CL_B } }), { params: { id: uA.id } })
  const empA2 = await prisma.employee.findUnique({ where: { id: eA.id } })
  const balA3 = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: eA.id, leaveTypeId: LT.ANNUAL_LEAVE, year: 0 } } })
  check('#3 改主屬店 → 仍然 4.74', rAcc2.status === 200 && empA2?.homeClinicId === CL_B && !!balA3 && near(balA3.entitled, 4.74), `status=${rAcc2.status} home=${empA2?.homeClinicId === CL_B ? 'CL_B ✓' : empA2?.homeClinicId} entitled=${balA3?.entitled}`)

  console.log('── #4 三頁文案統一（fs 斷言）──')
  const srcDir = path.resolve(__dirname, '../src/app/(protected)')
  const accountsTxt = fs.readFileSync(path.join(srcDir, 'accounts/page.tsx'), 'utf-8')
  const payrollTxt = fs.readFileSync(path.join(srcDir, 'payroll/[id]/employee/[empId]/page.tsx'), 'utf-8')
  const leaveTxt = fs.readFileSync(path.join(srcDir, 'leave/page.tsx'), 'utf-8')
  const unified = '按月累積（公司政策）· 日常餘額同離職結算同一口徑'
  check('#4 accounts 頁文案', accountsTxt.includes(unified) && !accountsTxt.includes('已賺取（已完成服務年度）'), 'accounts/page.tsx 已改統一口径')
  check('#4 payroll 頁文案', payrollTxt.includes(unified) && !payrollTxt.includes('按已完成服務年度計 · 進行中年度離職時按比例結算'), 'payroll/[empId]/page.tsx 已改統一口径')
  check('#4 leave 頁保留', leaveTxt.includes(unified), 'leave/page.tsx 原文案保留')

  console.log('── #13/#15/#16/#17/#18/#19 A 結算單（離職前）──')
  const pA0 = await previewGet(mkReq(`/api/employees/${eA.id}/resign-preview?lastDay=${LAST_DAY_A}`), { params: Promise.resolve({ id: eA.id }) })
  const jA0: any = await pA0.json()
  check('#13a status', pA0.status === 200, `status=${pA0.status}`)
  const ADW = 566.67 // 10×17000=170000 / 300 日 = 566.67（真路徑，唔係 fallback）
  // 結算 asOf = 最後工作日（9/30）**結束** → A 在職 274 日：accrued = round2(7×274/365) = 5.25；unused = 5.25−4 = 1.25
  const unusedBefore = 1.25
  const payoutBefore = Math.round(unusedBefore * ADW * 100) / 100
  check('#13a ADW 真路徑', jA0.settlement?.adw?.source === 'ADW' && near(jA0.settlement.adw.value, ADW), `adw=${jA0.settlement?.adw?.value} source=${jA0.settlement?.adw?.source}（WageHistory 10 個月真路徑，唔係 fallback）`)
  check('#13b 未放年假 1.25 日（計足最後一日）', near(jA0.leaveSettlement?.unused ?? -1, unusedBefore), `unused=${jA0.leaveSettlement?.unused} (accrued 5.25−4；cutoff 少計一日會得 1.24)`)
  check('#13c 年假薪酬 = 1.25×ADW', near(jA0.settlement?.unusedLeave?.payout ?? -1, payoutBefore), `payout=${jA0.settlement?.unusedLeave?.payout} = ${unusedBefore}×${ADW}`)
  check('#15a 時間帳戶欠款 2394 分 ≈ 4.43 日', jA0.settlement?.timebank?.debtMinutes === 2394 && near(jA0.settlement.timebank.debtDays, 4.43), `debt=${jA0.settlement?.timebank?.debtMinutes}分/${jA0.settlement?.timebank?.debtDays}日`)
  const base = Math.round((17000 + payoutBefore) * 100) / 100
  check('#15b 上限 1/4 + 1/2', near(jA0.settlement?.timebank?.caps?.quarter ?? -1, Math.round(base / 4 * 100) / 100) && near(jA0.settlement?.timebank?.caps?.half ?? -1, Math.round(base / 2 * 100) / 100), `base=${base} q=${jA0.settlement?.timebank?.caps?.quarter} h=${jA0.settlement?.timebank?.caps?.half}`)
  check('#15c 扣除欄空白（唔自動填）', jA0.settlement?.timebank?.deduction === null && typeof jA0.settlement.timebank.deductionNote === 'string', `deduction=${JSON.stringify(jA0.settlement?.timebank?.deduction)}`)
  check('#16 通知期人手（預設 null）', jA0.settlement?.notice?.days === null && jA0.settlement?.notice?.pay === null, `days=${jA0.settlement?.notice?.days} pay=${jA0.settlement?.notice?.pay}（預設唔推導）`)
  check('#18 s.25 期限 +7 日', jA0.settlement?.settleByDate === '2026-10-07', `settleByDate=${jA0.settlement?.settleByDate} (2026-09-30+7)`)
  const stKeys = JSON.stringify(Object.keys(jA0.settlement ?? {}))
  check('#19 休息日唔顯示喺結算單', Array.isArray(jA0.settlement?.excludedFromSettlement) && jA0.settlement.excludedFromSettlement.includes('REST_DAY') && !/restday/i.test(stKeys.replace(/REST_DAY/g, '')), `excluded=${JSON.stringify(jA0.settlement?.excludedFromSettlement)}（REST_DAY 額度 18/19/−1 唔入單）`)

  console.log('── #17 代通知金 = ADW × 日數（人手揀）──')
  for (const [nd, label] of [['0', '已做足'], ['7', '7日'], ['30', '1個月'], ['14', '自訂14']] as [string, string][]) {
    const r = await previewGet(mkReq(`/api/employees/${eA.id}/resign-preview?lastDay=${LAST_DAY_A}&noticeDays=${nd}`), { params: Promise.resolve({ id: eA.id }) })
    const j: any = await r.json()
    const expect = Math.round(Number(nd) * ADW * 100) / 100
    check(`#17 ${label} 代通知金`, r.status === 200 && j.settlement?.notice?.days === Number(nd) && near(j.settlement.notice.pay, expect), `days=${j.settlement?.notice?.days} pay=${j.settlement?.notice?.pay} = ${nd}×${ADW}`)
  }

  console.log('── #14 Selina 形：年假 0 日（未滿 3 個月）──')
  const pB0 = await previewGet(mkReq(`/api/employees/${eB.id}/resign-preview?lastDay=${LAST_DAY_B}`), { params: Promise.resolve({ id: eB.id }) })
  const jB0: any = await pB0.json()
  check('#14 B accrued/unused/payout = 0', pB0.status === 200 && near(jB0.leaveSettlement?.accrued ?? -1, 0) && near(jB0.leaveSettlement?.unused ?? -1, 0) && near(jB0.leaveSettlement?.payout ?? -1, 0), `accrued=${jB0.leaveSettlement?.accrued} unused=${jB0.leaveSettlement?.unused} payout=${jB0.leaveSettlement?.payout} serviceMonths=${jB0.leaveSettlement?.serviceMonths}`)
  check('#14b B 時間帳戶 −80 提示', jB0.settlement?.timebank?.debtMinutes === 80, `debt=${jB0.settlement?.timebank?.debtMinutes}分`)

  console.log('── #6/#8/#9/#10/#11/#12 A 標記離職 ──')
  const tvA0 = (await prisma.user.findUnique({ where: { id: uA.id } }))!.tokenVersion
  const rResignA = await resignPost(mkReq(`/api/employees/${eA.id}/resign`, { method: 'POST', body: { lastDay: LAST_DAY_A } }), { params: Promise.resolve({ id: eA.id }) })
  const jRA: any = await rResignA.json()
  check('#6 離職後未來班次 CANCELLED', rResignA.status === 200 && jRA.ok === true && jRA.shiftsCancelled === 3, `status=${rResignA.status} body=${JSON.stringify(jRA)}`)
  const shiftStatuses = await prisma.shift.findMany({ where: { employeeId: eA.id }, select: { status: true } })
  check('#6b 3 更全部 CANCELLED', shiftStatuses.every(s => s.status === 'CANCELLED') && shiftStatuses.length === 3, `statuses=${JSON.stringify(shiftStatuses)}`)

  console.log('── #7 排班總覽唔顯示已取消更 ──')
  const rShifts = await shiftsGet(mkReq('/api/shifts?startDate=2026-10-01&endDate=2026-10-03&pageSize=50'))
  const jShifts: any = await rShifts.json()
  const aShiftsVisible = (jShifts.shifts ?? []).filter((s: any) => s.employeeId === eA.id)
  check('#7 預設列表無 A 嘅已取消更', rShifts.status === 200 && aShiftsVisible.length === 0, `visible=${aShiftsVisible.length}（default exclude CANCELLED）`)
  const rShiftsC = await shiftsGet(mkReq('/api/shifts?startDate=2026-10-01&endDate=2026-10-03&status=CANCELLED&pageSize=50'))
  const jShiftsC: any = await rShiftsC.json()
  const aCancelled = (jShiftsC.shifts ?? []).filter((s: any) => s.employeeId === eA.id)
  check('#7b 顯式 status=CANCELLED 睇得到', rShiftsC.status === 200 && aCancelled.length === 3, `cancelled=${aCancelled.length}`)

  const balA4 = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: eA.id, leaveTypeId: LT.ANNUAL_LEAVE, year: 0 } } })
  check('#8 取消已批假期 → used 有減返', balA4?.used === 2 && near(balA4?.remaining ?? -1, 2.74), `used=${balA4?.used} (4→2, 返還 2 日) remaining=${balA4?.remaining} (0.74→2.74)`)
  const pA1 = await previewGet(mkReq(`/api/employees/${eA.id}/resign-preview?lastDay=${LAST_DAY_A}`), { params: Promise.resolve({ id: eA.id }) })
  const jA1: any = await pA1.json()
  check('#9 年假餘額增加 → 尾糧跟住多', near(jA1.leaveSettlement?.unused ?? -1, 3.25) && near(jA1.settlement?.unusedLeave?.payout ?? -1, Math.round(3.25 * ADW * 100) / 100), `unused=${jA1.leaveSettlement?.unused} (1.25→3.25) payout=${jA1.settlement?.unusedLeave?.payout}`)
  const uA1 = await prisma.user.findUnique({ where: { id: uA.id } })
  check('#10 session 即刻登出', uA1?.status === 'INACTIVE' && uA1?.tokenVersion === tvA0 + 1, `status=${uA1?.status} tokenVersion ${tvA0}→${uA1?.tokenVersion}`)
  const ftA = await prisma.faceTemplate.findFirst({ where: { employeeId: eA.id } })
  check('#11 人臉模板 active=false', ftA?.active === false, `active=${ftA?.active}`)
  const audit = await prisma.auditLog.findFirst({ where: { action: 'EMPLOYEE_RESIGN', entityId: eA.id }, orderBy: { createdAt: 'desc' } })
  check('#12 AuditLog 留痕 + 取消數量', !!audit && /取消班次=3/.test(audit.notes ?? '') && /取消假期=1/.test(audit.notes ?? ''), `notes=${audit?.notes}`)

  console.log('── B 標記離職（Selina 形）──')
  const rResignB = await resignPost(mkReq(`/api/employees/${eB.id}/resign`, { method: 'POST', body: { lastDay: LAST_DAY_B } }), { params: Promise.resolve({ id: eB.id }) })
  const jRB: any = await rResignB.json()
  const balB2 = await prisma.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: eB.id, leaveTypeId: LT.ANNUAL_LEAVE, year: 0 } } })
  check('#8b B 取消 9/15 假期還額度', rResignB.status === 200 && jRB.leavesCancelled === 1 && balB2?.used === 0 && balB2?.remaining === 0, `body=${JSON.stringify(jRB)} used=${balB2?.used}(1→0) remaining=${balB2?.remaining}(−1→0, entitled 0)`)
  const lrB = await prisma.leaveRequest.findFirst({ where: { employeeId: eB.id } })
  check('#6c B 假期 status=CANCELLED', lrB?.status === 'CANCELLED', `status=${lrB?.status}`)

  console.log('── sweep（逐表 0 殘留）──')
  const allEmp = [eA.id, eB.id, eC.id, eD.id]
  const allUser = [uA.id, uB.id, uC.id, uD.id]
  const sweep: Array<[string, (p: any) => Promise<{ count: number }>]> = [
    ['Notification', p => p.notification.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['TimeBankEntry', p => p.timeBankEntry.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['TimeBank', p => p.timeBank.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['LeaveRequest', p => p.leaveRequest.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['LeaveBalance', p => p.leaveBalance.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['WageHistory', p => p.wageHistory.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['Shift', p => p.shift.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['FaceTemplate', p => p.faceTemplate.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['PayRule', p => p.payRule.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['EmployeeClinic', p => p.employeeClinic.deleteMany({ where: { employeeId: { in: allEmp } } })],
    ['Employee', p => p.employee.deleteMany({ where: { id: { in: allEmp } } })],
    ['User', p => p.user.deleteMany({ where: { id: { in: allUser } } })],
  ]
  let sweepOk = true
  for (const [name, del] of sweep) {
    const r = await del(prisma)
    const ids = name === 'User' ? allUser : allEmp
    const col = name === 'User' || name === 'Employee' ? 'id' : '"employeeId"'
    const left = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM "${name}" WHERE ${col} IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`,
      ...ids,
    )) as Array<{ c: number }>
    if (r.count === 0 && left[0].c !== 0) { sweepOk = false; console.log(`  ⚠️ sweep ${name}: 0 deleted but ${left[0].c} remain`) }
    else console.log(`  🧹 ${name}: ${r.count} deleted, ${left[0].c} remain`)
  }
  check('sweep 0 殘留', sweepOk, '逐表核對 0 殘留（AuditLog append-only 保留 — informational）')

  // ── summary ──
  console.log(`\n══ SUMMARY: PASS=${pass} FAIL=${fail} ══`)
  if (failures.length) { console.log('FAILURES:'); failures.forEach(f => console.log('  - ' + f)) }
}

main()
  .catch(e => { console.error('E2E ERROR:', e); process.exitCode = 2 })
  .finally(async () => { await prisma.$disconnect() })

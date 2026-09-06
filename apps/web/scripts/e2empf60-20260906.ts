/**
 * cwm-mpf60-20260906 — T6 e2e（in-process）：MPF 60日規則 + 免供款期 + 結算單折現/MPF 行
 *
 * Run:
 *   set -a && . ./.env.development && set +a && npx tsx scripts/e2empf60-20260906.ts --phase1
 *   （而家跑 e2empf60-ui-20260906.ts — UI 必須喺任何 run 生成之前）
 *   set -a && . ./.env.development && set +a && npx tsx scripts/e2empf60-20260906.ts --phase2
 *   （resign 流 + run + settle + sweep）
 * ⚠️ generatePayrollRun 會令 ADW 轉 PayrollItem 路徑（cashout 變）→ UI 固定數字必須先跑。
 *
 * 格（MD §4 T1–T20 + §6.7 T21–T29 嘅 in-process 部分）：
 *  #1  Selina（71日、$5,568.18+折現$71.09=5,639.27）MPF $0 理由「低於 $7,100」★★★
 *  #2  45 日離職 → 0「未滿 60 日」
 *  #3–#6 免供款期邊界（7/1→7月$0/8月供；1/16→2月$0/3月供）
 *  #7  $18,000 長役 $900；#8 $40,000 → $1,500 封頂
 *  #9  OT 重算路徑 = 主路徑（OT1 長役 5%×gross / OT2 36日豁免 0）★★★
 *  #10 無 ctx → 舊行為
 *  #11/#12 60 日邊界要供 / 59 日唔供
 *  #13/#14/#15 Selina 畫面：折現獨立行 / MPF 行+理由 / 預估應付 $5,639.27 ★★★
 *  #16 高薪離職（HIGH）：應付減 MPF（$1,500 封頂）
 *  #19 ★ 在職 cohort 9 月計糧 deep-equal /tmp/emp-mpf60-before.json（生死格）
 *  #21 Selina 折現行「0.13 日 × ADW +$71.09」
 *  #22 逐行加總 = estPayable
 *  #25 欠款員工（DEBT）只有扣除行、無折現行
 *  #26 時間帳戶 = 0（ZERO）兩行都唔出
 *  #28 grep 540 結算檔零命中
 *  #29 自檢 block 存在（靜態；動態負測試喺 UI 腳本）
 *  phase2：resign → run → settle（SEL2/DEBT/ZERO）：run item MPF=0（主 caller ctx）、
 *       snapshot、tbDeduction 注入、source 轉 payrollItem。
 *
 * fixtures 全 synthetic 零 PII（前綴 e2em60 + 秒戳，sweep 0 殘留）。
 * UI 層（#23/#24/#27 畫面+print DOM）喺 e2empf60-ui-20260906.ts。
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createToken } from '../src/lib/auth'
import { calculatePayrollWithRules, calcMPF, generatePayrollRun } from '../src/lib/payroll-engine'
import { getMpfExemption } from '../src/lib/mpf-exemption'
import { calcMpfDisplay, calcTimebankDebtAmount, prefillTbDeduction } from '../src/lib/settlement-utils'
import { TIMEBANK_MINUTES_PER_DAY } from '../src/lib/timebank-constants'
import { hkDateStart, toHKDateStr, hkDayOfWeek } from '../src/lib/hk-date'
import { buildCohort, captureCohort, sweepCohort, PFX as COHORT_PFX } from './emp-mpf60-shared'
import { GET as resignPreviewGet } from '../src/app/api/employees/[id]/resign-preview/route'
import { POST as resignPost } from '../src/app/api/employees/[id]/resign/route'
import { POST as resignSettlePost } from '../src/app/api/employees/[id]/resign-settle/route'

const prisma = new PrismaClient()
const S = String(Math.floor(Date.now() / 1000))
const E = (suf: string) => `e2em60${S}${suf}` // cuid 形（lowercase alnum ≥20）

const LAST_DAY = '2026-09-11'
const JOIN = '2026-07-03' // → 9/11 = 71 曆日
const MONTH = '2026-09'
const ADW_RATE = 564.52 // WH 每曆日工資 → ADW 恰好 564.52
const SHIFT_DATES = ['2026-09-01', '2026-09-02', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09']
const OT_SHIFT_DATES = SHIFT_DATES.concat(['2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30']) // 20 更

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`) }
}
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) < tol
const r2 = (x: number) => Math.round(x * 100) / 100
const hkd = (d: string) => new Date(`${d}T00:00:00+08:00`)
const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00+08:00`)
const cutoffOf = (lastDay: string) => new Date(hkDateStart(lastDay).getTime() + 86400000)

let OWNER_ID = '', OWNER_TOKEN = ''
let CL_A = '', TMP_ID = ''
const empIds: string[] = [], userIds: string[] = [], runIds: string[] = []

function mkReq(pathStr: string, opts: { method?: string; body?: any } = {}) {
  const headers: Record<string, string> = { 'cookie': `session=${OWNER_TOKEN}` }
  if (opts.body) headers['content-type'] = 'application/json'
  return new NextRequest(`http://localhost:3000${pathStr}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

async function mkUser(name: string) {
  const u = await prisma.user.create({ data: { id: E(`u${Math.random().toString(36).slice(2, 8)}`), name, phone: `e2em60${S}${Math.random().toString(36).slice(2, 10)}`, email: `e2em60_${S}_${Math.random().toString(36).slice(2, 10)}@test.invalid`, role: 'EMPLOYEE', status: 'ACTIVE', password: 'x'.repeat(60) } })
  userIds.push(u.id); return u
}
async function mkEmp(uid: string, joinDate: string, clinicId: string) {
  const e = await prisma.employee.create({ data: { id: E(`e${Math.random().toString(36).slice(2, 8)}`), userId: uid, joinDate: hkd(joinDate), status: 'ACTIVE', homeClinicId: clinicId } })
  empIds.push(e.id)
  await prisma.employeeClinic.create({ data: { employeeId: e.id, clinicId, isPrimary: true } })
  return e
}
function mkCfg(salary: number): any {
  return {
    base_type: 'monthly', monthly_salary: salary,
    modifiers: { working_days: { rest_days: [6, 0] }, mpf: { enabled: true, rate: 0.05, min: 7100, max: 30000 } },
  }
}
async function mkPayRule(empId: string, cfg: any) {
  await prisma.payRule.create({ data: { employeeId: empId, payType: 'MONTHLY', baseAmount: cfg.monthly_salary, configJson: JSON.stringify(cfg), effectiveFrom: hkd('2020-01-01'), isActive: true, createdBy: OWNER_ID } })
}
async function mkShifts(empId: string, clinicId: string, dates: string[]) {
  await prisma.shift.createMany({ data: dates.map(d => ({
    employeeId: empId, clinicId, templateId: TMP_ID, status: 'CONFIRMED' as const, createdBy: OWNER_ID,
    date: hkd(d), startTime: at(d, '09:00'), endTime: at(d, '18:00'),
  })) })
}
async function mkPunch(empId: string, clinicId: string, d: string, hhmm: string, type: 'CLOCK_IN' | 'CLOCK_OUT') {
  await prisma.punchRecord.create({ data: { employeeId: empId, clinicId, punchTime: at(d, hhmm), punchType: type, source: 'SYSTEM' } })
}
/** WageHistory：每曆日 rate → ADW 恰好 rate */
async function mkWh(empId: string, months: string[], rate: number) {
  for (const pm of months) {
    const [y, m] = pm.split('-').map(Number)
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
    await prisma.wageHistory.create({ data: { employeeId: empId, periodMonth: pm, totalWage: r2(rate * days), excludedDays: 0, excludedWage: 0, calendarDays: days, createdBy: OWNER_ID } })
  }
}

/** 畫面口徑（同 ResignSettlementModal 同一套純函數）：cashout + MPF 行 + estPayable + 逐行加總 */
function cardMath(settlement: any, joinDate: Date | string, lastDay: string, tbDeductionVal: number | null) {
  const st = settlement
  const tb = st.timebank
  const adw = st.adw.value
  const tbPositiveCashout = tb && tb.balanceMinutes > 0 && adw > 0
    ? r2((tb.balanceMinutes / TIMEBANK_MINUTES_PER_DAY) * adw)
    : 0
  const mpfRelevantIncome = (st.monthWage?.basePay ?? 0) + (st.unusedLeave?.payout ?? 0) + (st.notice?.pay ?? 0) + tbPositiveCashout
  const mpfDisplay = calcMpfDisplay(joinDate, lastDay, mpfRelevantIncome)
  const mpfEmployee = mpfDisplay.employee
  const estPayable = ((st.monthWage?.basePay ?? 0) + st.unusedLeave.payout + (st.notice.pay ?? 0) + tbPositiveCashout - mpfEmployee) - (tbDeductionVal || 0)
  const lineSum = (st.monthWage?.basePay ?? 0) + (st.unusedLeave?.payout ?? 0) + (st.notice?.pay ?? 0)
    + tbPositiveCashout - (tbDeductionVal ?? 0) - mpfEmployee
  return { st, tb, adw, tbPositiveCashout, mpfRelevantIncome, mpfDisplay, mpfEmployee, estPayable, lineSum, cashoutRowShown: tbPositiveCashout > 0, debtRowShown: tb.debtMinutes > 0 }
}

async function preview(empId: string, lastDay: string) {
  const res = await resignPreviewGet(mkReq(`/api/employees/${empId}/resign-preview?lastDay=${lastDay}`), { params: Promise.resolve({ id: empId }) })
  const body = await res.json() as any
  if (res.status !== 200) throw new Error(`preview ${empId} → ${res.status}: ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

async function sweep() {
  for (const rid of runIds) {
    await prisma.payrollItem.deleteMany({ where: { runId: rid } })
    await prisma.payrollRun.deleteMany({ where: { id: rid } })
  }
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.timeBank.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.wageHistory.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.$executeRawUnsafe(`ALTER TABLE "PunchRecord" DISABLE TRIGGER no_mutate_punch`)
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditLog" DISABLE TRIGGER no_mutate_audit`)
  try {
    await prisma.auditLog.deleteMany({ where: { targetEmployeeId: { in: empIds } } })
    await prisma.punchRecord.deleteMany({ where: { employeeId: { in: empIds } } })
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "PunchRecord" ENABLE TRIGGER no_mutate_punch`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditLog" ENABLE TRIGGER no_mutate_audit`)
  }
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.shift.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.notification.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.employeeClinic.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.payRule.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.employee.deleteMany({ where: { id: { in: empIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
}

async function main() {
  const PHASE2 = process.argv.includes('--phase2')
  const PHASE1 = process.argv.includes('--phase1')
  if (!PHASE1 && !PHASE2) { console.error('usage: --phase1 | --phase2'); process.exit(1) }

  // self-heal：append-only trigger 必須喺
  const trigs = await prisma.$queryRawUnsafe<Array<{ name: string; en: string }>>(`SELECT tgname AS name, tgenabled AS en FROM pg_trigger WHERE tgname IN ('no_mutate_punch','no_mutate_audit')`)
  for (const t of trigs) if (t.en !== 'O') {
    const tbl = t.name === 'no_mutate_punch' ? '"PunchRecord"' : '"AuditLog"'
    console.log(`⚠️ ${t.name} trigger 未啟用（crash 殘留）— 重新啟用`)
    await prisma.$executeRawUnsafe(`ALTER TABLE ${tbl} ENABLE TRIGGER ${t.name}`)
  }

  const clinics = await prisma.clinic.findMany({ orderBy: { id: 'asc' }, take: 2 })
  if (clinics.length < 2) { console.error('✖ 少於 2 間 clinic'); process.exit(1) }
  CL_A = clinics[0].id
  const owner = await prisma.user.findFirst({ where: { email: 'owner@clinic.demo' } })
  if (!owner) { console.error('✖ seed owner 唔存在'); process.exit(1) }
  OWNER_ID = owner.id
  OWNER_TOKEN = createToken({ userId: owner.id, role: owner.role, clinics: [], tokenVersion: owner.tokenVersion ?? 0 })
  TMP_ID = (await prisma.shiftTemplate.findFirst({ where: { name: '全日' } }))!.id

  if (PHASE2) {
    // ──────────────── phase2：resign 流 + run + settle + sweep ────────────────
    console.log('── phase2：resign SEL2/DEBT/ZERO → generate run → settle → sweep ──')
    const fx = JSON.parse(fs.readFileSync('/tmp/emp-mpf60-fixture.json', 'utf8'))
    const sel2 = await prisma.employee.findUnique({ where: { id: fx.sel2Id } })
    const debt = await prisma.employee.findUnique({ where: { id: fx.debtId } })
    const zero = await prisma.employee.findUnique({ where: { id: fx.zeroId } })
    const set = await prisma.employee.findUnique({ where: { id: fx.setId } })
    if (!sel2 || !debt || !zero || !set) { console.error('✖ phase1 fixtures 唔存在（要唔係已 sweep）'); process.exit(1) }
    const today = toHKDateStr(new Date())
    if (today.slice(0, 7) !== MONTH) { console.error(`✖ e2e 只喺 ${MONTH} 有效，而家 ${today} — 拒絕`); process.exit(1) }

    let runId1 = ''
    {
      for (const [name, emp, ld] of [['SEL2', sel2, LAST_DAY], ['DEBT', debt, LAST_DAY], ['ZERO', zero, LAST_DAY], ['SET', set, fx.setLastDay]] as const) {
        const rs = await resignPost(mkReq(`/api/employees/${emp.id}/resign`, { method: 'POST', body: { lastDay: ld } }), { params: Promise.resolve({ id: emp.id }) })
        const b = await rs.clone().json().catch(() => ({}))
        check(`resign ${name} ok`, rs.status === 200, `status=${rs.status} ${JSON.stringify(b).slice(0, 150)}`)
      }
      const after = await prisma.employee.findUnique({ where: { id: sel2.id } })
      check('SEL2 resignedAt = 9/12 HK 午夜', after?.resignedAt?.getTime() === cutoffOf(LAST_DAY).getTime(), `got ${after?.resignedAt}`)
    }
    {
      const run = (await generatePayrollRun(null, MONTH)) as { runId: string; itemCount: number }
      runId1 = run.runId; runIds.push(runId1)
      check('run 生成成功', !!runId1 && run.itemCount > 0, `items=${run.itemCount}`)
      const itSel2 = await prisma.payrollItem.findFirst({ where: { runId: runId1, employeeId: sel2.id } })
      const itDebt = await prisma.payrollItem.findFirst({ where: { runId: runId1, employeeId: debt.id } })
      const itSet = await prisma.payrollItem.findFirst({ where: { runId: runId1, employeeId: set.id } })
      check('SEL2 run basePay = $5,568.18', near(itSel2?.basePay ?? -1, 5568.18), `base=${itSel2?.basePay} err=${itSel2?.detailJson?.slice(0, 120)}`)
      check('SEL2 run MPF = 0（主 caller ctx：71日 + <7,100）', itSel2?.detailJson ? JSON.parse(itSel2.detailJson).mpf === 0 : false, `detail=${itSel2?.detailJson?.slice(0, 200)}`)
      check('DEBT run basePay = $5,568.18 + MPF 0', near(itDebt?.basePay ?? -1, 5568.18) && (itDebt?.detailJson ? JSON.parse(itDebt.detailJson).mpf === 0 : false), `base=${itDebt?.basePay}`)
      check('SET run basePay = $3,181.82 + MPF 0', near(itSet?.basePay ?? -1, 3181.82) && (itSet?.detailJson ? JSON.parse(itSet.detailJson).mpf === 0 : false), `base=${itSet?.basePay} detail=${itSet?.detailJson?.slice(0, 150)}`)
    }
    {
      const body = await preview(sel2.id, LAST_DAY)
      const m = cardMath(body.settlement, JOIN, LAST_DAY, null)
      check('SEL2 resign 後 source=payrollItem 同值 $5,568.18', body.settlement.monthWage?.source === 'payrollItem' && near(body.settlement.monthWage?.basePay ?? -1, 5568.18), `mw=${JSON.stringify(body.settlement.monthWage)}`)
      check('SEL2 口徑一致：逐行加總 = estPayable', near(m.lineSum, m.estPayable, 0.001), `sum=${m.lineSum} est=${m.estPayable}`)
    }
    {
      // 時機守衛（resigv3 MD §4.4）：lastDay 未到 → settle 400
      for (const [name, emp] of [['SEL2', sel2], ['DEBT', debt], ['ZERO', zero]] as const) {
        const rf = await resignSettlePost(mkReq(`/api/employees/${emp.id}/resign-settle`, { method: 'POST', body: { lastDay: LAST_DAY, noticeDays: 0 } }), { params: Promise.resolve({ id: emp.id }) })
        const bf = await rf.clone().json().catch(() => ({})) as any
        check(`settle ${name} 未來 lastDay → 400 時機守衛`, rf.status === 400 && /未到/.test(bf?.error ?? ''), `status=${rf.status} err=${bf?.error}`)
      }
      // SET 真 settle 流（past lastDay）：tbDeduction 預填注入
      const stBody = await preview(set.id, fx.setLastDay)
      const stAdw = stBody.settlement.adw.value
      const stDebtAmount = calcTimebankDebtAmount(stBody.settlement.timebank.debtMinutes, stAdw).tbAmount
      const stPrefill = prefillTbDeduction(stDebtAmount, stBody.settlement.timebank.caps.quarter)
      check('SET 預填 tbDeduction > 0（run 後 ADW 路徑）', stPrefill > 0, `adw=${stAdw} debt=${stDebtAmount} prefill=${stPrefill} cap=${stBody.settlement.timebank.caps.quarter}`)
      const rs = await resignSettlePost(mkReq(`/api/employees/${set.id}/resign-settle`, { method: 'POST', body: { lastDay: fx.setLastDay, noticeDays: 0, tbDeduction: stPrefill } }), { params: Promise.resolve({ id: set.id }) })
      const bs = await rs.clone().json().catch(() => ({}))
      check('settle SET ok（tbDeduction 預填注入）', rs.status === 200, `status=${rs.status} ${JSON.stringify(bs).slice(0, 200)}`)
      const itS = await prisma.payrollItem.findFirst({ where: { runId: runId1, employeeId: set.id } })
      const snapS = itS?.resignSettlementJson ? JSON.parse(itS.resignSettlementJson) : null
      check('SET snapshot.tbDeduction = 預填值', snapS?.tbDeduction === stPrefill, `tbDed=${snapS?.tbDeduction} want=${stPrefill}`)
      check('SET snapshot ratio 4/22 + lastDay 9/4', snapS?.monthWageRatio?.numerator === 4 && snapS?.monthWageRatio?.denominator === 22 && snapS?.monthWageRatio?.lastDay === fx.setLastDay, `snap=${JSON.stringify(snapS?.monthWageRatio)}`)
      const run2 = (await generatePayrollRun(null, MONTH)) as { runId: string; itemCount: number }
      runIds.push(run2.runId)
      const itS2 = await prisma.payrollItem.findFirst({ where: { runId: run2.runId, employeeId: set.id } })
      // 重算 totalPayable = run base + snapshot 年假薪酬 − tbDed（結算書口徑）
      const snapLeave = snapS?.annualLeavePay ?? 0
      const wantS2 = r2((itS2?.basePay ?? 0) + snapLeave - stPrefill)
      check('SET 重算 run totalPayable = base + 年假 − tbDed（注入生效）', itS2?.totalPayable != null && near(itS2.totalPayable, wantS2), `total=${itS2?.totalPayable} want=${wantS2} (base=${itS2?.basePay} leave=${snapLeave} tbDed=${stPrefill})`)
    }

    // ── sweep（前綴全洗）────────────────────────────────────────────
    console.log('── sweep（e2em60 前綴 → 0 殘留）──')
    const allEmps = await prisma.employee.findMany({ where: { id: { startsWith: fx.pfx } }, select: { id: true, userId: true } })
    for (const e of allEmps) { if (!empIds.includes(e.id)) empIds.push(e.id); if (e.userId && !userIds.includes(e.userId)) userIds.push(e.userId) }
    await sweep()
    const cEmp = await prisma.employee.count({ where: { id: { startsWith: fx.pfx } } })
    const cUser = await prisma.user.count({ where: { id: { startsWith: fx.pfx } } })
    const cRun = await prisma.payrollRun.count({ where: { id: { in: runIds } } })
    const cTb = await prisma.timeBank.count({ where: { employeeId: { in: empIds } } })
    const cWh = await prisma.wageHistory.count({ where: { employeeId: { in: empIds } } })
    const cItem = await prisma.payrollItem.count({ where: { runId: { in: runIds } } })
    check('sweep 0 殘留', cEmp === 0 && cUser === 0 && cRun === 0 && cTb === 0 && cWh === 0 && cItem === 0, `emp=${cEmp} user=${cUser} run=${cRun} tb=${cTb} wh=${cWh} item=${cItem}`)
    console.log(`\n═══ RESULT (phase2 final): PASS=${pass} FAIL=${fail} ═══`)
    if (fails.length) { for (const f of fails) console.log(`  ✖ ${f}`) }
    fs.rmSync('/tmp/emp-mpf60-fixture.json', { force: true })
    await prisma.$disconnect()
    process.exit(fail === 0 ? 0 : 1)
  }

  // ──────────────── phase1：#19 + fixtures + 全部 preview 斷言 ────────────────
  const today = toHKDateStr(new Date())
  if (today.slice(0, 7) !== MONTH) { console.error(`✖ e2e 只喺 ${MONTH} 有效，而家 ${today} — 拒絕`); process.exit(1) }

  // self-heal：洗上次殘留 fixture（冪等）
  if (fs.existsSync('/tmp/emp-mpf60-fixture.json')) {
    try {
      const oldFx = JSON.parse(fs.readFileSync('/tmp/emp-mpf60-fixture.json', 'utf8'))
      const oldEmps = await prisma.employee.findMany({ where: { id: { startsWith: oldFx.pfx } }, select: { id: true, userId: true } })
      if (oldEmps.length > 0) {
        console.log(`── self-heal：洗上次殘留 fixture（${oldFx.pfx}，${oldEmps.length} 人）──`)
        for (const e of oldEmps) { if (!empIds.includes(e.id)) empIds.push(e.id); if (e.userId && !userIds.includes(e.userId)) userIds.push(e.userId) }
        await sweep()
      }
      fs.rmSync('/tmp/emp-mpf60-fixture.json', { force: true })
    } catch (e: any) { console.log(`⚠️ self-heal 失敗（繼續）：${e.message}`) }
  }

  // ═══ #19 ★ 在職 cohort 一分唔變（deep-equal BEFORE 基準）════════════
  console.log('── #19 在職 cohort（e2em60b 前綴，對 /tmp/emp-mpf60-before.json）──')
  {
    const before = JSON.parse(fs.readFileSync('/tmp/emp-mpf60-before.json', 'utf8'))
    const ids = await buildCohort()
    const cap = await captureCohort(ids)
    await sweepCohort(COHORT_PFX)
    let same = true
    const diffs: string[] = []
    for (const k of Object.keys(before.results)) {
      try {
        const a = JSON.stringify(before.results[k]), b = JSON.stringify(cap[k])
        if (a !== b) { same = false; diffs.push(`${k} 不同`) }
      } catch (e: any) { same = false; diffs.push(`${k} error ${e.message}`) }
    }
    check('#19 在職 3 員工 9 月計糧 deep-equal 舊基準（生死格）', same, diffs.join('; '))
    const mpfNow = Object.fromEntries(Object.entries(cap).map(([k, v]: any) => [k, v.detail?.mpf]))
    check('#19 MPF 值 = 900/1500/355', mpfNow.R1 === 900 && mpfNow.R2 === 1500 && mpfNow.R3 === 355, JSON.stringify(mpfNow))
  }

  // ═══ fixtures（synthetic，零 PII）═══════════════════════════════════
  console.log('── seed fixtures ──')
  const sel = await mkEmp((await mkUser('E2E MPF60 Selina')).id, JOIN, CL_A)
  await mkPayRule(sel.id, mkCfg(17500)); await mkShifts(sel.id, CL_A, SHIFT_DATES); await mkWh(sel.id, ['2026-07', '2026-08', '2026-09'], ADW_RATE)
  for (const d of SHIFT_DATES.slice(0, 6)) { await mkPunch(sel.id, CL_A, d, '09:00', 'CLOCK_IN'); await mkPunch(sel.id, CL_A, d, '18:00', 'CLOCK_OUT') }
  await mkPunch(sel.id, CL_A, '2026-09-09', '09:00', 'CLOCK_IN'); await mkPunch(sel.id, CL_A, '2026-09-09', '19:08', 'CLOCK_OUT') // OT 68 分 → TB +68

  const sel2 = await mkEmp((await mkUser('E2E MPF60 Selina2')).id, JOIN, CL_A)
  await mkPayRule(sel2.id, mkCfg(17500)); await mkShifts(sel2.id, CL_A, SHIFT_DATES); await mkWh(sel2.id, ['2026-07', '2026-08', '2026-09'], ADW_RATE)
  for (const d of SHIFT_DATES.slice(0, 6)) { await mkPunch(sel2.id, CL_A, d, '09:00', 'CLOCK_IN'); await mkPunch(sel2.id, CL_A, d, '18:00', 'CLOCK_OUT') }
  await mkPunch(sel2.id, CL_A, '2026-09-09', '09:00', 'CLOCK_IN'); await mkPunch(sel2.id, CL_A, '2026-09-09', '19:08', 'CLOCK_OUT')

  const debt = await mkEmp((await mkUser('E2E MPF60 Debt')).id, JOIN, CL_A)
  await mkPayRule(debt.id, mkCfg(17500)); await mkShifts(debt.id, CL_A, SHIFT_DATES); await mkWh(debt.id, ['2026-07', '2026-08', '2026-09'], ADW_RATE)
  for (const d of SHIFT_DATES.slice(0, 6)) { await mkPunch(debt.id, CL_A, d, '10:30', 'CLOCK_IN'); await mkPunch(debt.id, CL_A, d, '18:00', 'CLOCK_OUT') } // 6×90 分遲到 = 欠 540

  const zero = await mkEmp((await mkUser('E2E MPF60 Zero')).id, JOIN, CL_A)
  await mkPayRule(zero.id, mkCfg(17500)); await mkShifts(zero.id, CL_A, SHIFT_DATES); await mkWh(zero.id, ['2026-07', '2026-08', '2026-09'], ADW_RATE)

  // SET：真 settle 流用（lastDay 必須 ≤ 今日 → 用 9/4；6/1 入 = 154 日 > 60）
  const SET_JOIN = '2026-06-01', SET_LAST = '2026-09-04'
  const set = await mkEmp((await mkUser('E2E MPF60 Set')).id, SET_JOIN, CL_A)
  await mkPayRule(set.id, mkCfg(17500)); await mkShifts(set.id, CL_A, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']); await mkWh(set.id, ['2026-07', '2026-08', '2026-09'], ADW_RATE)
  for (const d2 of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']) { await mkPunch(set.id, CL_A, d2, '10:30', 'CLOCK_IN'); await mkPunch(set.id, CL_A, d2, '18:00', 'CLOCK_OUT') } // 4×90 分 = 欠 360

  const high = await mkEmp((await mkUser('E2E MPF60 High')).id, '2024-01-01', CL_A)
  await mkPayRule(high.id, mkCfg(40000))
  const highShifts: string[] = []
  for (let i = 1; i <= 30; i++) { const dd = `2026-09-${String(i).padStart(2, '0')}`; if (![0, 6].includes(hkDayOfWeek(dd))) highShifts.push(dd) }
  await mkShifts(high.id, CL_A, highShifts)
  const whMonths: string[] = []
  { const d0 = new Date('2025-10-01T00:00:00+08:00'); for (let i = 0; i < 12; i++) { const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i, 1)); whMonths.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`) } }
  await mkWh(high.id, whMonths, 1333.33)

  const ot1 = await mkEmp((await mkUser('E2E MPF60 OT1')).id, '2025-01-01', CL_A)
  await mkPayRule(ot1.id, mkCfg(18000)); await mkShifts(ot1.id, CL_A, OT_SHIFT_DATES)
  await mkPunch(ot1.id, CL_A, '2026-09-01', '09:00', 'CLOCK_IN'); await mkPunch(ot1.id, CL_A, '2026-09-01', '20:00', 'CLOCK_OUT') // OT 120 分

  const ot2 = await mkEmp((await mkUser('E2E MPF60 OT2')).id, '2026-08-25', CL_A)
  await mkPayRule(ot2.id, mkCfg(18000)); await mkShifts(ot2.id, CL_A, OT_SHIFT_DATES)
  await mkPunch(ot2.id, CL_A, '2026-09-01', '09:00', 'CLOCK_IN'); await mkPunch(ot2.id, CL_A, '2026-09-01', '20:00', 'CLOCK_OUT')

  // ═══ #2 #3–#8 #10 #11/#12 calcMPF 層 ══════════════════════════════
  console.log('── #2–#8 #10–#12 calcMPF 層 ──')
  const C = { enabled: true, rate: 0.05, min: 7100, max: 30000 }
  const d = (s: string) => hkd(s)
  const mpfCases: Array<[string, number, any, number]> = [
    ['#2 離職 45 日（7/29 入 lastDay 9/11）', 20000, { joinDate: d('2026-07-29'), periodMonth: d('2026-09-01'), lastDay: d('2026-09-11') }, 0],
    ['#3 入職 7/1 睇 7 月（免供款期）', 20000, { joinDate: d('2026-07-01'), periodMonth: d('2026-07-01') }, 0],
    ['#4 入職 7/1 睇 8 月（開始供）', 20000, { joinDate: d('2026-07-01'), periodMonth: d('2026-08-01') }, 1000],
    ['#5 入職 1/16 睇 2 月（不完整糧期）', 20000, { joinDate: d('2026-01-16'), periodMonth: d('2026-02-01') }, 0],
    ['#6 入職 1/16 睇 3 月（開始供）', 20000, { joinDate: d('2026-01-16'), periodMonth: d('2026-03-01') }, 1000],
    ['#7 長役 $18,000 → $900', 18000, { joinDate: d('2025-01-01'), periodMonth: d('2026-09-01') }, 900],
    ['#8 長役 $40,000 → $1,500 封頂', 40000, { joinDate: d('2024-01-01'), periodMonth: d('2026-09-01') }, 1500],
    ['#10 無 ctx → 舊行為', 20000, undefined, 1000],
    ['#11 啱啱 60 日（8/2 入 9/30 末）要供', 20000, { joinDate: d('2026-08-02'), periodMonth: d('2026-09-01') }, 1000],
    ['#12 59 日（8/3 入 9/30 末）唔供', 20000, { joinDate: d('2026-08-03'), periodMonth: d('2026-09-01') }, 0],
  ]
  for (const [name, wage, ctx, want] of mpfCases) check(name, near(calcMPF(wage, C, ctx), want), `got ${calcMPF(wage, C, ctx)}`)
  {
    const disp = calcMpfDisplay(d('2026-07-29'), '2026-09-11', 20000)
    check('#2 理由「未滿 60 日」', disp.employee === 0 && !!disp.zeroReason && disp.zeroReason.includes('未滿 60 日'), `reason=${disp.zeroReason} days=${disp.employedDays}`)
  }
  {
    const ex = getMpfExemption({ joinDate: d(JOIN), periodMonth: d('2026-09-01'), lastDay: d(LAST_DAY) })
    check('Selina employedDays = 71', ex?.employedDays === 71, `got ${ex?.employedDays}`)
  }

  // ═══ Selina 畫面口徑（#1 #13 #14 #15 #21 #22）═══════════════════════
  console.log('── Selina 預覽（resign 前，source=preview）──')
  {
    const body = await preview(sel.id, LAST_DAY)
    const selSt = body.settlement
    check('#13 當月工資 = $5,568.18（7/22）', near(selSt.monthWage?.basePay ?? -1, 5568.18), `mw=${JSON.stringify(selSt.monthWage)}`)
    check('#13 ratio 7/22', selSt.monthWageRatio?.numerator === 7 && selSt.monthWageRatio?.denominator === 22, `ratio=${JSON.stringify(selSt.monthWageRatio)}`)
    check('ADW = $564.52（WageHistory 路徑）', near(selSt.adw?.value ?? -1, 564.52) && selSt.adw?.source === 'ADW', `adw=${JSON.stringify(selSt.adw)}`)
    check('TB balance = +68 分（engine 由 punch OT 計出）', selSt.timebank?.balanceMinutes === 68 && selSt.timebank?.debtMinutes === 0, `tb=${JSON.stringify({ b: selSt.timebank?.balanceMinutes, d: selSt.timebank?.debtMinutes })}`)
    const m = cardMath(selSt, JOIN, LAST_DAY, null)
    check('#1 MPF $0 ＋ 理由「低於 $7,100」', m.mpfEmployee === 0 && !!m.mpfDisplay.zeroReason && m.mpfDisplay.zeroReason.includes('低於 $7,100'), `disp=${JSON.stringify(m.mpfDisplay)}`)
    check('#14 有關入息 = 5,568.18+71.09 = 5,639.27（拍板③ 折現計入）', near(m.mpfRelevantIncome, 5639.27), `income=${m.mpfRelevantIncome}`)
    check('#21 折現獨立行 = 0.13 日 × ADW = +$71.09', near(m.tbPositiveCashout, 71.09) && (68 / TIMEBANK_MINUTES_PER_DAY).toFixed(2) === '0.13', `cashout=${m.tbPositiveCashout} label=${(68 / TIMEBANK_MINUTES_PER_DAY).toFixed(2)}`)
    check('#15/#22 預估應付 = $5,639.27', near(m.estPayable, 5639.27), `est=${m.estPayable}`)
    check('#22 逐行加總 = estPayable', near(m.lineSum, m.estPayable, 0.001), `sum=${m.lineSum} est=${m.estPayable}`)
  }

  // ═══ #25 欠款員工（DEBT）：只有扣除行、無折現行 ═════════════════════
  console.log('── DEBT 預覽（TB −540 分）──')
  {
    const body = await preview(debt.id, LAST_DAY)
    const m = cardMath(body.settlement, JOIN, LAST_DAY, null)
    check('#25 TB 欠款 = 540 分（balance −540）', body.settlement.timebank?.debtMinutes === 540 && body.settlement.timebank?.balanceMinutes === -540, `tb=${JSON.stringify({ b: body.settlement.timebank?.balanceMinutes, d: body.settlement.timebank?.debtMinutes })}`)
    check('#25 無折現行（balance ≤ 0）', m.cashoutRowShown === false && m.tbPositiveCashout === 0, `cashout=${m.tbPositiveCashout}`)
    const debtAmount = calcTimebankDebtAmount(540, m.adw).tbAmount
    const prefill = prefillTbDeduction(debtAmount, body.settlement.timebank.caps.quarter)
    check('#25 扣除預填 = min(欠款, 1/4 上限) = $564.52', near(debtAmount, 564.52) && near(prefill, 564.52), `debt=${debtAmount} prefill=${prefill} cap=${body.settlement.timebank.caps.quarter}`)
    check('#25 MPF $0 ＋ 理由（無折現，入息 5,568.18 < 7,100）', m.mpfEmployee === 0 && !!m.mpfDisplay.zeroReason && m.mpfDisplay.zeroReason.includes('低於 $7,100'), `disp=${JSON.stringify(m.mpfDisplay)}`)
    const m2 = cardMath(body.settlement, JOIN, LAST_DAY, prefill)
    check('#25 estPayable = 5,568.18 − 564.52 = $5,003.66（扣除行有效）', near(m2.estPayable, 5003.66), `est=${m2.estPayable}`)
  }

  // ═══ #26 時間帳戶 = 0（ZERO）：兩行都唔出 ══════════════════════════
  console.log('── ZERO 預覽（無 TB）──')
  {
    const body = await preview(zero.id, LAST_DAY)
    const m = cardMath(body.settlement, JOIN, LAST_DAY, null)
    check('#26 TB = 0（無 row / balance 0）', body.settlement.timebank?.balanceMinutes === 0 && body.settlement.timebank?.debtMinutes === 0, `tb=${JSON.stringify({ b: body.settlement.timebank?.balanceMinutes, d: body.settlement.timebank?.debtMinutes })}`)
    check('#26 折現行唔出 + 欠款行唔出', m.cashoutRowShown === false && m.debtRowShown === false, `cashout=${m.tbPositiveCashout} debt=${body.settlement.timebank.debtMinutes}`)
    check('#26 MPF 行照有（$0 + 理由）', m.mpfEmployee === 0 && !!m.mpfDisplay.zeroReason, `disp=${JSON.stringify(m.mpfDisplay)}`)
    check('#26 estPayable = $5,568.18', near(m.estPayable, 5568.18), `est=${m.estPayable}`)
  }

  // ═══ SET 預覽（settle 流 fixture：ratio 4/22、TB −360）═════════════════════
  console.log('── SET 預覽（lastDay 9/4，4 更、TB −360）──')
  {
    const body = await preview(set.id, SET_LAST)
    const m = cardMath(body.settlement, SET_JOIN, SET_LAST, null)
    check('SET ratio 4/22 → base $3,181.82', body.settlement.monthWageRatio?.numerator === 4 && body.settlement.monthWageRatio?.denominator === 22 && near(body.settlement.monthWage?.basePay ?? -1, 3181.82), `mw=${JSON.stringify(body.settlement.monthWage)}`)
    check('SET TB 欠款 = 360 分', body.settlement.timebank?.debtMinutes === 360 && body.settlement.timebank?.balanceMinutes === -360, `tb=${JSON.stringify({ b: body.settlement.timebank?.balanceMinutes, d: body.settlement.timebank?.debtMinutes })}`)
    check('SET MPF $0（base < 7,100）+ 理由', m.mpfEmployee === 0 && !!m.mpfDisplay.zeroReason && m.mpfDisplay.zeroReason.includes('低於 $7,100'), `disp=${JSON.stringify(m.mpfDisplay)}`)
    const stPayout = body.settlement.unusedLeave?.payout ?? 0
    check('SET estPayable = base + 年假（無折現行）', near(m.estPayable, 3181.82 + stPayout) && !m.cashoutRowShown, `est=${m.estPayable} payout=${stPayout}`)
  }

  // ═══ #16 高薪離職（HIGH）：應付減 MPF（封頂 $1,500）═════════════════
  // lastDay = 9/30（全月）→ ratio 22/22 = 全月薪
  console.log('── HIGH 預覽（$40k 全月，lastDay 9/30）──')
  {
    const body = await preview(high.id, '2026-09-30')
    const m = cardMath(body.settlement, '2024-01-01', '2026-09-30', null)
    const payout = body.settlement.unusedLeave?.payout ?? 0
    check('#16 當月工資 = $40,000（22/22）', near(body.settlement.monthWage?.basePay ?? -1, 40000), `mw=${JSON.stringify(body.settlement.monthWage)}`)
    check('#16 有關入息 ≥ 7,100 → 要供', m.mpfRelevantIncome >= 7100, `income=${m.mpfRelevantIncome}`)
    check('#16 MPF = $1,500（$30,000 封頂 × 5%）', m.mpfEmployee === 1500 && m.mpfDisplay.zeroReason === null, `mpf=${m.mpfEmployee} reason=${m.mpfDisplay.zeroReason}`)
    check('#16 應付 = 工資＋年假 − MPF（減咗 MPF）', near(m.estPayable, 40000 + payout - 1500), `est=${m.estPayable} payout=${payout}`)
    check('#16 逐行加總 = estPayable', near(m.lineSum, m.estPayable, 0.001), `sum=${m.lineSum} est=${m.estPayable}`)
  }

  // ═══ #9 OT 重算路徑 = 主路徑（engine 直算）══════════════════════════
  console.log('── #9 OT 重算路徑（engine）──')
  {
    const monthDate = new Date('2026-09-01T00:00:00+08:00')
    const r1 = await calculatePayrollWithRules(ot1.id, monthDate, CL_A, mkCfg(18000))
    if (r1.error) throw new Error(`OT1 engine: ${r1.error}`)
    const g1 = (r1 as any).detail.grossPay
    const want1 = r2(Math.min(g1, 30000) * 0.05)
    const ctx1 = { joinDate: hkd('2025-01-01'), periodMonth: monthDate, lastDay: null }
    check('#9 OT1 長役：detail.grossPay ≥ 7,100', g1 >= 7100, `gross=${g1}`)
    check('#9 OT1 重算 MPF = 主路徑公式（5%×gross）', (r1 as any).detail.mpf === want1 && (r1 as any).detail.mpf === calcMPF(g1, C, ctx1), `mpf=${(r1 as any).detail.mpf} want=${want1}`)
    const r2x = await calculatePayrollWithRules(ot2.id, monthDate, CL_A, mkCfg(18000))
    if (r2x.error) throw new Error(`OT2 engine: ${r2x.error}`)
    const g2 = (r2x as any).detail.grossPay
    const ctx2 = { joinDate: hkd('2026-08-25'), periodMonth: monthDate, lastDay: null }
    check('#9 OT2 36 日（<60）：重算 MPF = 0（ctx 生效，唔係 5%）', g2 >= 7100 && (r2x as any).detail.mpf === 0 && calcMPF(g2, C, ctx2) === 0, `gross=${g2} mpf=${(r2x as any).detail.mpf}`)
  }

  // ═══ #28 grep 540 結算檔零命中 ══════════════════════════════════════
  console.log('── #28 grep 540 ──')
  {
    const out = execSync(`grep -n "540" src/components/ResignSettlementModal.tsx src/lib/settlement-utils.ts src/lib/resign-settlement.ts src/lib/mpf-exemption.ts "src/app/api/employees/[id]/resign-preview/route.ts" "src/app/api/employees/[id]/resign-settle/route.ts" 2>/dev/null || true`, { cwd: process.cwd(), encoding: 'utf8' })
    check('#28 540 結算檔零命中（用 TIMEBANK_MINUTES_PER_DAY）', out.trim() === '', `hits:\n${out.trim()}`)
  }

  // ═══ #29 自檢 block 存在（靜態；動態負測試喺 UI 腳本）═══════════════
  console.log('── #29 加總自檢（靜態）──')
  {
    const src = fs.readFileSync('src/components/ResignSettlementModal.tsx', 'utf8')
    const hasGuard = src.includes("process.env.NODE_ENV !== 'production'")
    const hasErr = src.includes('console.error(`[resign-settlement] ⛔ 逐行加總')
    const idx = src.indexOf('const _lineSum')
    const sumBlock = idx >= 0 ? src.slice(idx, idx + 320) : ''
    const hasTerms = ['monthWage?.basePay', 'unusedLeave?.payout', 'notice?.pay', 'tbPositiveCashout', 'tbDeductionVal', 'mpfEmployee'].every(t => sumBlock.includes(t))
    check('#29 dev 自檢 block（NODE_ENV guard + console.error + 六項齊）', hasGuard && hasErr && hasTerms, `guard=${hasGuard} err=${hasErr} block=${JSON.stringify(sumBlock.slice(0, 200))}`)
  }

  // ── UI 交接檔（UI 先跑；phase2 先 sweep）─────────────────────────
  fs.writeFileSync('/tmp/emp-mpf60-fixture.json', JSON.stringify({
    pfx: `e2em60${S}`, selId: sel.id, sel2Id: sel2.id, debtId: debt.id, zeroId: zero.id, highId: high.id, setId: set.id,
    ownerToken: OWNER_TOKEN, lastDay: LAST_DAY, setLastDay: SET_LAST,
  }, null, 2))
  console.log('\n◆ fixtures 已寫 /tmp/emp-mpf60-fixture.json — 而家跑 UI 腳本，UI 完先跑 --phase2')

  console.log(`\n═══ RESULT (phase1 pre-UI): PASS=${pass} FAIL=${fail} ═══`)
  if (fails.length) { for (const f of fails) console.log(`  ✖ ${f}`) }
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(async (e) => {
  console.error('FATAL', e)
  try {
    const fxPath = '/tmp/emp-mpf60-fixture.json'
    if (fs.existsSync(fxPath)) {
      const fx = JSON.parse(fs.readFileSync(fxPath, 'utf8'))
      const allEmps = await prisma.employee.findMany({ where: { id: { startsWith: fx.pfx } }, select: { id: true, userId: true } })
      for (const e of allEmps) { if (!empIds.includes(e.id)) empIds.push(e.id); if (e.userId && !userIds.includes(e.userId)) userIds.push(e.userId) }
    }
    await sweep(); console.log('（sweep 已執行）')
  } catch { /* ignore */ }
  await prisma.$disconnect()
  process.exit(2)
})

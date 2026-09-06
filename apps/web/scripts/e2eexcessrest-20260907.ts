/**
 * cwm-excessrest-20260907 — T4 e2e（in-process，跟 e2ecal 模式）
 *
 * Run:
 *   set -a && . ./.env.development && set +a && npx tsx scripts/e2eexcessrest-20260907.ts
 *   （主跑：純函數格 + Luna 9 項 + 前後位置 6 項 + 邊界 7 項 + 回歸 4 項；fixture 留低俾 UI e2e）
 *   → UI e2e（e2eexcessrest-ui-20260907.ts，要 dev server :3000）
 *   set -a && . ./.env.development && set +a && npx tsx scripts/e2eexcessrest-20260907.ts --sweep
 *   （掃 e2erx 前綴全部 fixture → 0 殘留）
 *
 * 格（MD §六）：
 *  Luna 9 項（§6.1）：#1 4200 / #2 實放 6 / #3 應得 2.4 / #4 −1680 / #5 +245.88 / #6 有關入息 2765.88
 *                      / #7 MIN 2130 / #8 MPF −138.29（卡片）/ #9 實發 2627.59（卡片）
 *                      + engine 側 2520 / 126.00 / 2394.00（★ 折現唔入 engine — 兩口徑各斷各嘅，唔好逼 138.29）
 *  前後位置（§6.2）：#10 ⑤ 減基數 / #11 CC2 欠款唔減基數 / #12 CC2 MPF 基數 19,961.75（欠款前）
 *                    / #13 s.32 1/4 上限基數 19,961.75（扣 MPF 前）/ #14 兩扣款未合併 / #15 OT 重算路徑
 *  邊界（§6.3）：#16 完整月 excess 0 / #17 放少過應得 excess 0 / #18 已批年假唔計非工作日
 *                / #19 公眾假同上 / #20 無 RESTDAY_GRANT 應得 0 / #21 預填 1680 可改 / #22 日率 ÷30
 *  回歸（§6.4）：#23 在職計糧 deep-equal 零變動 / #24 PDF 逐行加總（UI e2e）/ #25 有關入息行（UI e2e）/ #26 guard+tsc（T5）
 *
 * fixtures 全 synthetic 零 PII（前綴 e2erx + 秒戳）：
 *  Luna：入職 7/1、最後工作日 9/9、月薪 14000、3 更（9/1-9/3）、WH 7+8 月 14000（ADW 451.61）、
 *        RESTDAY_GRANT 9 月 8 日（11520 分）、TB +294 分、年假已放晒（unused 0）
 *  CC2：入職 1/1、最後工作日 9/30（完整月）、月薪 17500、22 個 weekday 更、WH 7 月 14,563.80（ADW 469.80）、
 *        TB −540 分（欠款 1 日）、unused 年假 5.24 日（7 日表 × 273/365）→ leavePayout 2,461.75
 *  OTS：入職 7/1、9/1-9/3 更 + 9/1 OUT 20:00（120 分 OT）→ OT 重算路徑
 *  ALB：#18（9/11 已批年假 1 日）  PHB：#19（9/19 中秋翌日 PH）
 * ⚠️ 做完 sweep 0 殘留（--sweep）。
 */
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createToken } from '../src/lib/auth'
import { calculatePayrollWithRules, calcMPF } from '../src/lib/payroll-engine'
import { adjustMpfMinForPeriod } from '../src/lib/mpf-exemption'
import { calcMpfDisplay, calcExcessRestDayDeduction } from '../src/lib/settlement-utils'
import { countHKDaysInclusive, hkDateStart, getMonthRange, toHKDateStr, hkDayOfWeek } from '../src/lib/hk-date'
import { buildCohort, captureCohort, sweepCohort, PFX as COHORT_PFX, CFG } from './emp-caldayratio-shared'
import { GET as resignPreviewGet } from '../src/app/api/employees/[id]/resign-preview/route'

const prisma = new PrismaClient()
const S = String(Math.floor(Date.now() / 1000))
const PFX = `e2erx${S}` // fixture 前綴（cuid 形 lowercase alnum ≥20）
const E = (suf: string) => `${PFX}${suf}`

const MONTH = '2026-09'
const today = toHKDateStr(new Date())
const LAST_DAY = addDaysStr(today, 2)        // Luna 最後工作日 = 今日 +2（2026-09-07 → 2026-09-09，MD §一）
const CUTOFF_L = new Date(hkDateStart(LAST_DAY).getTime() + 86400000) // resignedAt 口徑（翌日 HK 午夜）

function addDaysStr(d: string, n: number): string {
  const [y, m, dd] = d.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10)
}

let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`) }
}
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) < tol
const hkd = (d: string) => new Date(`${d}T00:00:00+08:00`)

let CL_A = '', OWNER_ID = '', OWNER_TOKEN = ''
const empIds: string[] = [], userIds: string[] = []

function mkReq(pathStr: string) {
  return new NextRequest(`http://localhost:3000${pathStr}`, { headers: { 'cookie': `session=${OWNER_TOKEN}` } })
}
async function preview(empId: string, lastDay: string) {
  const res = await resignPreviewGet(mkReq(`/api/employees/${empId}/resign-preview?lastDay=${lastDay}`), { params: Promise.resolve({ id: empId }) })
  const body = await res.json().catch(() => ({}))
  if (res.status !== 200) throw new Error(`preview ${empId} lastDay=${lastDay} → ${res.status} ${JSON.stringify(body).slice(0, 200)}`)
  return body
}

async function sweepAll(prefix: string) {
  const emps = await prisma.employee.findMany({ where: { id: { startsWith: prefix } }, select: { id: true, userId: true } })
  const ids = emps.map(e => e.id)
  const uids = [...new Set(emps.map(e => e.userId))]
  if (ids.length === 0) return
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.timeBank.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.wageHistory.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.$executeRawUnsafe(`ALTER TABLE "PunchRecord" DISABLE TRIGGER no_mutate_punch`)
  await prisma.$executeRawUnsafe(`ALTER TABLE "AuditLog" DISABLE TRIGGER no_mutate_audit`)
  try {
    await prisma.auditLog.deleteMany({ where: { targetEmployeeId: { in: ids } } })
    await prisma.punchRecord.deleteMany({ where: { employeeId: { in: ids } } })
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "PunchRecord" ENABLE TRIGGER no_mutate_punch`)
    await prisma.$executeRawUnsafe(`ALTER TABLE "AuditLog" ENABLE TRIGGER no_mutate_audit`)
  }
  await prisma.leaveRequest.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.shift.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.notification.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.leaveBalance.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.payrollItem.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.employeeClinic.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.payRule.deleteMany({ where: { employeeId: { in: ids } } })
  await prisma.employee.deleteMany({ where: { id: { in: ids } } })
  await prisma.user.deleteMany({ where: { id: { in: uids } } })
}

async function selfHealTriggers() {
  const trigs = await prisma.$queryRawUnsafe<Array<{ name: string; en: string }>>(`SELECT tgname AS name, tgenabled AS en FROM pg_trigger WHERE tgname IN ('no_mutate_punch','no_mutate_audit')`)
  for (const t of trigs) {
    if (t.en !== 'O') {
      const tbl = t.name === 'no_mutate_punch' ? '"PunchRecord"' : '"AuditLog"'
      console.log(`⚠️ ${t.name} trigger 未啟用（上次 crash 殘留）— 重新啟用`)
      await prisma.$executeRawUnsafe(`ALTER TABLE ${tbl} ENABLE TRIGGER ${t.name}`)
    }
  }
}

async function main() {
  if (process.argv.includes('--sweep')) {
    await selfHealTriggers()
    await sweepAll('e2erx')
    const c1 = await prisma.employee.count({ where: { id: { startsWith: 'e2erx' } } })
    const c2 = await prisma.user.count({ where: { id: { startsWith: 'e2erx' } } })
    fs.rmSync('/tmp/emp-excessrest-fixture.json', { force: true })
    console.log(`sweep 完成：emp=${c1} user=${c2}（必須 0/0）`)
    await prisma.$disconnect()
    process.exit(c1 === 0 && c2 === 0 ? 0 : 1)
  }

  if (today.slice(0, 7) !== MONTH) { console.error(`✖ e2e 只喺 ${MONTH} 有效（日期鎖死 9 月），而家 ${today} — 拒絕`); process.exit(1) }
  if (!/^2026-09-0[1-9]$|2026-09-[12]\d$|^2026-09-30$/.test(LAST_DAY)) { console.error(`✖ LAST_DAY ${LAST_DAY} 唔喺 9 月 — 拒絕`); process.exit(1) }
  await selfHealTriggers()
  // self-heal：洗上次殘留 fixture（冪等）
  const stale = await prisma.employee.count({ where: { id: { startsWith: 'e2erx' } } })
  if (stale > 0) { console.log(`── self-heal：洗殘留 fixture（${stale} 人）──`); await sweepAll('e2erx') }
  fs.rmSync('/tmp/emp-excessrest-fixture.json', { force: true })

  const clinics = await prisma.clinic.findMany({ orderBy: { id: 'asc' }, take: 1 })
  const owner = await prisma.user.findFirst({ where: { email: 'owner@clinic.demo' } })
  if (!clinics[0] || !owner) { console.error('✖ seed missing (clinic/owner)'); process.exit(1) }
  CL_A = clinics[0].id; OWNER_ID = owner.id
  OWNER_TOKEN = createToken({ userId: owner.id, role: owner.role, clinics: [], tokenVersion: owner.tokenVersion ?? 0 })
  const tmp = (await prisma.shiftTemplate.findFirst({ where: { name: '全日' } }))!
  const ltAnnual = (await prisma.leaveType.findUnique({ where: { systemKey: 'ANNUAL_LEAVE' } }))!
  const ltRest = (await prisma.leaveType.findUnique({ where: { systemKey: 'REST_DAY' } }))!

  const monthDate = hkd('2026-09-01')
  const ctxL = { joinDate: hkd('2026-07-01'), periodMonth: monthDate, lastDay: hkd(LAST_DAY) } // Luna MPF ctx
  const ctxC = { joinDate: hkd('2026-01-01'), periodMonth: monthDate, lastDay: hkd('2026-09-30') } // CC2 MPF ctx

  // ═══ 純函數層（無 DB）══════════════════════════════════════════
  console.log('── 純函數：calcExcessRestDayDeduction ──')
  // #16 完整月短路（employedDays = monthDays）→ 0
  {
    const r = calcExcessRestDayDeduction({ employedDays: 30, monthDays: 30, workedDays: 22, paidLeaveDays: 0, publicHolidayDays: 1, monthlyRestGrantDays: 8, monthlySalary: 14000 })
    check('#16 完整月短路 → excess 0 / amount 0', r.excessDays === 0 && r.amount === 0, `got ${JSON.stringify(r)}`)
  }
  // #17 放少過應得 → 0（唔會負）
  {
    const r = calcExcessRestDayDeduction({ employedDays: 9, monthDays: 30, workedDays: 8, paidLeaveDays: 0, publicHolidayDays: 0, monthlyRestGrantDays: 8, monthlySalary: 14000 })
    check('#17 放少過應得（實放 1 < 應得 2.4）→ excess 0（唔會負→加錢）', r.actualRestDays === 1 && r.entitledRestDays === 2.4 && r.excessDays === 0 && r.amount === 0, `got ${JSON.stringify(r)}`)
  }
  // #20 無 RESTDAY_GRANT → 應得 0 → 全部非工作日算超額
  {
    const r = calcExcessRestDayDeduction({ employedDays: 9, monthDays: 30, workedDays: 3, paidLeaveDays: 0, publicHolidayDays: 0, monthlyRestGrantDays: 0, monthlySalary: 14000 })
    check('#20 無 RESTDAY_GRANT → 應得 0、excess 6、amount 2800', r.entitledRestDays === 0 && r.actualRestDays === 6 && r.excessDays === 6 && r.amount === 2800, `got ${JSON.stringify(r)}`)
  }
  // #22 日率 ÷30（曆日）唔係 ÷22
  {
    const r = calcExcessRestDayDeduction({ employedDays: 9, monthDays: 30, workedDays: 3, paidLeaveDays: 0, publicHolidayDays: 0, monthlyRestGrantDays: 8, monthlySalary: 14000 })
    const div22 = Math.round(3.6 * (14000 / 22) * 100) / 100
    check('#22 日率 ÷30 → 1680（唔係 ÷22 嘅 ' + div22 + '）', r.excessDays === 3.6 && r.amount === 1680 && r.amount !== div22, `got ${JSON.stringify(r)}`)
  }
  // #18/#19 純函數口徑（年假／PH 唔算非工作日）
  {
    const withLeave = calcExcessRestDayDeduction({ employedDays: 14, monthDays: 30, workedDays: 8, paidLeaveDays: 1, publicHolidayDays: 0, monthlyRestGrantDays: 8, monthlySalary: 14000 })
    const withPh = calcExcessRestDayDeduction({ employedDays: 25, monthDays: 30, workedDays: 10, paidLeaveDays: 0, publicHolidayDays: 1, monthlyRestGrantDays: 8, monthlySalary: 14000 })
    check('#18 純函數：已批年假 1 日 → 非工作日 5（唔係 6）', withLeave.actualRestDays === 5, `got ${JSON.stringify(withLeave)}`)
    check('#19 純函數：PH 1 日 → 非工作日 14（唔係 15）', withPh.actualRestDays === 14, `got ${JSON.stringify(withPh)}`)
  }

  // ═══ #23 生死格：在職 cohort deep-equal（BEFORE 基準 = 改 engine 前 capture）══════
  console.log('── #23 在職 cohort deep-equal（e2calb 前綴 + 4 真實在職）──')
  {
    const before = JSON.parse(fs.readFileSync('/tmp/emp-excessrest-before.json', 'utf8'))
    const ids = await buildCohort()
    const capAfter = await captureCohort(ids)
    await sweepCohort(COHORT_PFX)
    const norm = (cap: Record<string, any>) => {
      const out: Record<string, any> = {}
      for (const [k, v] of Object.entries(cap)) {
        const c = JSON.parse(JSON.stringify(v))
        if (c.detail?.employedRatioDetail) c.detail.employedRatioDetail = { value: c.detail.employedRatioDetail.value }
        out[k] = c
      }
      return out
    }
    const a = norm(before.results), b = norm(capAfter)
    let same = true; const diffs: string[] = []
    for (const k of Object.keys(a)) {
      try {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { same = false; diffs.push(`${k} 不同`) }
      } catch (e: any) { same = false; diffs.push(`${k} error ${e.message}`) }
    }
    check('#23 全部在職計糧（4 synthetic + 4 真實）deep-equal 零變動（生死格）', same, diffs.join('; '))
  }

  // ═══ fixtures（synthetic，零 PII）═══════════════════════════════
  console.log(`── seed fixtures（${PFX} 前綴）──`)
  const mkUser = async (name: string, phone: string) => {
    const u = await prisma.user.create({ data: { id: E(`u${Math.random().toString(36).slice(2, 6)}`), name, phone, password: 'x'.repeat(60), status: 'ACTIVE', role: 'EMPLOYEE' } })
    userIds.push(u.id); return u
  }
  const mkEmp = async (uid: string, join: string) => {
    const e = await prisma.employee.create({ data: { id: E(`e${Math.random().toString(36).slice(2, 6)}`), userId: uid, joinDate: hkd(join), status: 'ACTIVE', homeClinicId: CL_A } })
    empIds.push(e.id); return e
  }
  const mkRule = async (empId: string, salary: number) => {
    await prisma.payRule.create({ data: { employeeId: empId, payType: 'MONTHLY', baseAmount: salary, configJson: JSON.stringify(CFG(salary)), effectiveFrom: hkd('2020-01-01'), isActive: true, createdBy: OWNER_ID } })
  }
  const mkShifts = async (empId: string, days: string[]) => {
    if (days.length === 0) return
    await prisma.shift.createMany({ data: days.map(d => ({ employeeId: empId, clinicId: CL_A, templateId: tmp.id, date: hkd(d), startTime: new Date(`${d}T09:00:00+08:00`), endTime: new Date(`${d}T18:00:00+08:00`), status: 'CONFIRMED' as const, createdBy: OWNER_ID })) })
  }
  const mkPunch = async (empId: string, d: string, hhmm: string, type: 'CLOCK_IN' | 'CLOCK_OUT') => {
    await prisma.punchRecord.create({ data: { employeeId: empId, clinicId: CL_A, punchTime: new Date(`${d}T${hhmm}:00+08:00`), punchType: type, source: 'SYSTEM' } })
  }
  const mkWH = async (empId: string, pm: string, totalWage: number, calendarDays: number) => {
    await prisma.wageHistory.create({ data: { employeeId: empId, periodMonth: pm, totalWage, excludedDays: 0, excludedWage: 0, calendarDays, note: 'e2erx seed', createdBy: OWNER_ID } })
  }
  const mkTBE = async (empId: string, d: string, type: string, minutes: number, note: string) => {
    await prisma.timeBankEntry.create({ data: { employeeId: empId, date: hkd(d), type, minutes, note, createdBy: OWNER_ID } })
  }

  // LUNA：入職 7/1、最後工作日 9/9（今日+2）、月薪 14000、3 更（9/1-9/3）、WH 7+8 → ADW 451.61
  //   ★ 3 個工作日全部打卡（IN 09:00 / OUT 18:00）— 無 punch = engine 計 absent → 扣缺勤（MD engine 口徑 2520 前提）
  const luna = await mkEmp((await mkUser('E2E RX Luna', `e2erx${S}l1`)).id, '2026-07-01')
  await mkRule(luna.id, 14000)
  const lunaDays = ['2026-09-01', '2026-09-02', '2026-09-03']
  await mkShifts(luna.id, lunaDays)
  for (const d of lunaDays) { await mkPunch(luna.id, d, '09:00', 'CLOCK_IN'); await mkPunch(luna.id, d, '18:00', 'CLOCK_OUT') }
  await mkWH(luna.id, '2026-07', 14000, 31)
  await mkWH(luna.id, '2026-08', 14000, 31)
  await mkTBE(luna.id, '2026-09-01', 'REST_TO_ACCOUNT', 294, 'e2erx luna tb +294')
  await mkTBE(luna.id, '2026-09-01', 'RESTDAY_GRANT', 11520, 'restday_grant_2026_9: 發放8天休息日')
  await prisma.leaveBalance.create({ data: { employeeId: luna.id, leaveTypeId: ltAnnual.id, year: 0, entitled: 1.36, used: 1.36, remaining: 0 } }) // 年假已放晒 → unused 0
  await prisma.leaveBalance.create({ data: { employeeId: luna.id, leaveTypeId: ltRest.id, year: 2026, entitled: 18, used: 10, remaining: 8 } }) // 裝飾（MD §一）

  // CC2：入職 1/1、最後工作日 9/30（完整月）、月薪 17500、22 個 weekday 更、WH 7 月 14,563.80 → ADW 469.80
  const cc2 = await mkEmp((await mkUser('E2E RX CC2', `e2erx${S}c2`)).id, '2026-01-01')
  await mkRule(cc2.id, 17500)
  const cc2Days: string[] = []
  for (let i = 1; i <= 30; i++) { const dd = `2026-09-${String(i).padStart(2, '0')}`; if (![0, 6].includes(hkDayOfWeek(dd))) cc2Days.push(dd) }
  await mkShifts(cc2.id, cc2Days)
  // ★ 全部 22 個工作日打卡（無 punch = absent → 扣缺勤；MD engine 口徑 19,961.75 前提）
  for (const d of cc2Days) { await mkPunch(cc2.id, d, '09:00', 'CLOCK_IN'); await mkPunch(cc2.id, d, '18:00', 'CLOCK_OUT') }
  await mkWH(cc2.id, '2026-07', 14563.80, 31)
  await mkTBE(cc2.id, '2026-09-01', 'REST_TO_ACCOUNT', -540, 'e2erx cc2 tb debt -540')

  // OTS：入職 7/1、9/1-9/3 更 + 9/1 OUT 20:00（120 分 OT）→ OT 重算路徑（#15）+ 兩扣款（#14）
  const ots = await mkEmp((await mkUser('E2E RX OTS', `e2erx${S}o1`)).id, '2026-07-01')
  await mkRule(ots.id, 14000)
  await mkShifts(ots.id, ['2026-09-01', '2026-09-02', '2026-09-03'])
  await mkPunch(ots.id, '2026-09-01', '09:00', 'CLOCK_IN')
  await mkPunch(ots.id, '2026-09-01', '20:00', 'CLOCK_OUT') // 120 分 OT
  // ★ 9/2、9/3 正常打卡（防 absent 扣缺勤污染的基數斷言）
  for (const d of ['2026-09-02', '2026-09-03']) { await mkPunch(ots.id, d, '09:00', 'CLOCK_IN'); await mkPunch(ots.id, d, '18:00', 'CLOCK_OUT') }
  await mkWH(ots.id, '2026-07', 14000, 31)
  await mkWH(ots.id, '2026-08', 14000, 31)
  await mkTBE(ots.id, '2026-09-01', 'RESTDAY_GRANT', 11520, 'restday_grant_2026_9: 發放8天休息日')

  // ALB：#18 — 9/11 已批年假 1 日（唔算非工作日）
  const alb = await mkEmp((await mkUser('E2E RX ALB', `e2erx${S}a1`)).id, '2026-07-01')
  await mkRule(alb.id, 14000)
  await mkShifts(alb.id, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10'])
  await prisma.leaveRequest.create({ data: { employeeId: alb.id, leaveTypeId: ltAnnual.id, startDate: hkd('2026-09-11'), endDate: hkd('2026-09-11'), days: 1, status: 'APPROVED', approverId: OWNER_ID, approvedAt: hkd('2026-09-07') } })
  await mkTBE(alb.id, '2026-09-01', 'RESTDAY_GRANT', 11520, 'restday_grant_2026_9: 發放8天休息日')

  // PHB：#19 — 9/19 中秋翌日（PH，週六）喺受僱期 9/1-9/25 內
  const phb = await mkEmp((await mkUser('E2E RX PHB', `e2erx${S}p1`)).id, '2026-07-01')
  await mkRule(phb.id, 14000)
  await mkShifts(phb.id, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14'])
  await mkTBE(phb.id, '2026-09-01', 'RESTDAY_GRANT', 11520, 'restday_grant_2026_9: 發放8天休息日')

  // ═══ Luna 預覽（MD §6.1 卡片 9 項）════════════════════════════
  console.log(`── Luna 預覽（lastDay ${LAST_DAY}）──`)
  const pL = await preview(luna.id, LAST_DAY)
  const stL = pL.settlement
  {
    // #1 當月工資 4200（9/30 曆日口徑）
    check('#1 Luna 當月工資 = $4,200.00（14000 × 9/30）', stL.monthWage?.source === 'preview' && near(stL.monthWage?.basePay ?? -1, 4200), `mw=${JSON.stringify(stL.monthWage)}`)
    // #2 實放 6 / #3 應得 2.4 / #4 −1680
    const xr = stL.excessRest
    check('#2 實放休息日 = 6（9 − 3 工作日，反推）', xr?.actualRestDays === 6, `xr=${JSON.stringify(xr)}`)
    check('#3 按比例應得 = 2.4（8 × 9/30）', xr?.entitledRestDays === 2.4, `xr=${JSON.stringify(xr)}`)
    check('#4 超額扣款 = −$1,680.00（3.6 日）', xr?.excessDays === 3.6 && xr?.amount === 1680 && stL.excessRestDeduction === 1680, `xr=${JSON.stringify(xr)} prefill=${stL.excessRestDeduction}`)
    // #5 折現 +245.88（294/540 × ADW 451.61）
    const cashout = stL.timebank?.balanceMinutes > 0 ? Math.round((stL.timebank.balanceMinutes / 540) * (stL.adw?.value ?? 0) * 100) / 100 : 0
    check('#5 時間帳戶折現 = +$245.88（294 分 ÷ 540 × ADW）', near(stL.adw?.value ?? -1, 451.61) && stL.timebank?.balanceMinutes === 294 && near(cashout, 245.88), `adw=${stL.adw} tb=${JSON.stringify(stL.timebank)} cashout=${cashout}`)
    // #6 有關入息 2765.88 = 4200 + 0 + 0 + 245.88 − 1680
    const relevant = (stL.monthWage?.basePay ?? 0) + (stL.unusedLeave?.payout ?? 0) + (stL.notice?.pay ?? 0) + cashout - (stL.excessRestDeduction ?? 0)
    check('#6 有關入息 = $2,765.88（4200 + 245.88 − 1680）', near(relevant, 2765.88) && (stL.unusedLeave?.payout ?? 0) === 0, `relevant=${relevant} unusedLeave=${JSON.stringify(stL.unusedLeave)}`)
    // #7 MIN 2130 / #8 MPF −138.29（卡片口徑）
    const MIN = adjustMpfMinForPeriod(7100, ctxL)
    const disp = calcMpfDisplay('2026-07-01', LAST_DAY, relevant)
    check('#7 MPF MIN = $7,100 × 9/30 = $2,130', MIN === 2130, `MIN=${MIN}`)
    check('#8 MPF（卡片）= −$138.29（2765.88 × 5%）', near(disp.employee, 138.29) && disp.zeroReason === null, `disp=${JSON.stringify(disp)}`)
    // #9 實發（卡片）= 2765.88 − 138.29 = 2627.59
    const estPayable = relevant - disp.employee - 0 // 無欠款
    check('#9 實發（卡片）= $2,627.59', near(estPayable, 2627.59), `est=${estPayable}`)
  }

  // ═══ Luna engine 側（2520 / 126.00 / 2394.00 — 折現唔入 engine）══════
  console.log('── Luna engine 側（⑤ 1680 注入）──')
  const rL = await calculatePayrollWithRules(luna.id, monthDate, CL_A, CFG(14000), {
    resignedAtOverride: CUTOFF_L,
    resignSettlement: { annualLeavePay: 0, noticePay: 0, tbDeduction: null, excessRestDeduction: 1680 },
  })
  if (rL.error) throw new Error(`Luna engine error: ${rL.error}`)
  const dL = rL.detail as any
  {
    check('engine Luna grossPay = $2,520.00（4200 − 1680；⑤ 減基數）', near(dL.grossPay, 2520), `gross=${dL.grossPay}`)
    check('engine Luna MPF = $126.00（2520 × 5%；MIN 2130 過線）', near(dL.mpf, 126), `mpf=${dL.mpf} gross=${dL.grossPay}`)
    check('engine Luna netPay = $2,394.00（2520 − 126 − 0 欠款）', near(dL.netPay, 2394), `net=${dL.netPay}`)
    // #10 ⑤ 減低 MPF 基數：有 ⑤ 126.00 < 無 ⑤ 210.00（4200 × 5%）
    const mpfNoExcess = calcMPF(4200, { enabled: true, rate: 0.05, min: 7100, max: 30000 }, ctxL)
    check('#10 ⑤ 減低 MPF 基數（126.00 < 無⑤ 210.00）', near(dL.mpf, 126) && near(mpfNoExcess, 210) && dL.mpf < mpfNoExcess, `mpf=${dL.mpf} vs noExcess=${mpfNoExcess}`)
    // #21 預填 1680 可人手改：engine 用注入值 1000 → gross 3200
    const rL2 = await calculatePayrollWithRules(luna.id, monthDate, CL_A, CFG(14000), {
      resignedAtOverride: CUTOFF_L,
      resignSettlement: { annualLeavePay: 0, noticePay: 0, tbDeduction: null, excessRestDeduction: 1000 },
    })
    check('#21 預填可改（注入 1000 → grossPay 3200）', rL2.error ? false : near((rL2.detail as any).grossPay, 3200), `gross=${(rL2 as any).detail?.grossPay}`)
  }

  // ═══ CC2（完整月 + 欠款）════════════════════════════════════════
  console.log('── CC2 預覽（lastDay 2026-09-30，完整月 + 欠款 540 分）──')
  const pC = await preview(cc2.id, '2026-09-30')
  const stC = pC.settlement
  {
    check('#16 CC2 完整月（30/30）excess 0（金額一分唔變）', near(stC.monthWage?.basePay ?? -1, 17500) && stC.excessRest?.excessDays === 0 && stC.excessRest?.amount === 0, `mw=${JSON.stringify(stC.monthWage)} xr=${JSON.stringify(stC.excessRest)}`)
    // #13 s.32 1/4 上限基數 = 19,961.75（17500 + leavePayout 2461.75；扣 MPF 前）
    check('#13 CC2 finalPeriodWage = $19,961.75（17,500 + 2,461.75 年假；quarterCap 4,990.44）',
      near(stC.timebank?.caps?.finalPeriodWage ?? -1, 19961.75) && near(stC.timebank?.caps?.quarter ?? -1, 4990.44) && near(stC.unusedLeave?.payout ?? -1, 2461.75) && near(stC.unusedLeave?.days ?? -1, 5.24, 0.011),
      `caps=${JSON.stringify(stC.timebank?.caps)} unusedLeave=${JSON.stringify(stC.unusedLeave)} adw=${stC.adw}`)
    // 欠款 540 分 → 1 日 × ADW 469.80
    check('CC2 欠款 540 分（1 日）× ADW 469.80 = 469.80', stC.timebank?.balanceMinutes === -540 && stC.timebank?.debtMinutes === 540 && near(stC.timebank?.debtDays ?? -1, 1), `tb=${JSON.stringify(stC.timebank)}`)
  }
  // #12/#11 engine：MPF 基數 = 19,961.75（欠款前）；欠款唔減基數
  const CUTOFF_C = new Date(hkd('2026-09-30').getTime() + 86400000)
  const rC = await calculatePayrollWithRules(cc2.id, monthDate, CL_A, CFG(17500), {
    resignedAtOverride: CUTOFF_C,
    resignSettlement: { annualLeavePay: 2461.75, noticePay: 0, tbDeduction: 469.80, excessRestDeduction: 0 },
  })
  if (rC.error) throw new Error(`CC2 engine error: ${rC.error}`)
  const dC = rC.detail as any
  const rC2 = await calculatePayrollWithRules(cc2.id, monthDate, CL_A, CFG(17500), {
    resignedAtOverride: CUTOFF_C,
    resignSettlement: { annualLeavePay: 2461.75, noticePay: 0, tbDeduction: null, excessRestDeduction: 0 },
  })
  const dC2 = (rC2 as any).detail as any
  {
    check('#12 CC2 MPF 基數 = $19,961.75（17,500 + rsGrossAdd 2,461.75；欠款前）', near(dC.grossPay, 19961.75), `gross=${dC.grossPay}`)
    check('#12 CC2 MPF = $998.09（19,961.75 × 5%；完整月 MIN 7100 過線）', near(dC.mpf, 998.09), `mpf=${dC.mpf}`)
    // #11 欠款唔減 MPF 基數：有欠款 vs 無欠款 → mpf 一樣
    check('#11 欠款唔減 MPF 基數（有/無欠款 mpf 皆 998.09；net 分屬兩邊）', near(dC.mpf, dC2.mpf, 0.001) && near(dC2.netPay, 19961.75 - 998.09) && near(dC.netPay, 19961.75 - 998.09 - 469.80), `mpf=${dC.mpf}/${dC2.mpf} net=${dC.netPay}/${dC2.netPay}`)
  }

  // ═══ OTS：OT 重算路徑 + 兩扣款未合併（#14 #15）══════════════════
  //   雙跑法：⑤ = 0 vs 1680 → gross 差恰 1680（OT 重算路徑覆寫 detail 後都成立）— 唔使知 otPay 公式
  //   ★ ot_threshold: 8（月度配置 REQUIRED；冇 = hourlyEquivalent 0 → otPay 恆 0，OT 重算路徑無實物可斷）
  console.log('── OTS engine（⑤ 0/1680 雙跑 + ⑥ 1000；120 分 OT）──')
  const OTS_CFG: any = { ...CFG(14000), ot_threshold: 8 }
  const CUTOFF_O = new Date(hkd(LAST_DAY).getTime() + 86400000)
  const ctxO = { joinDate: hkd('2026-07-01'), periodMonth: monthDate, lastDay: hkd(LAST_DAY) }
  const rO0 = await calculatePayrollWithRules(ots.id, monthDate, CL_A, OTS_CFG, {
    resignedAtOverride: CUTOFF_O,
    resignSettlement: { annualLeavePay: 0, noticePay: 0, tbDeduction: 1000, excessRestDeduction: 0 },
  })
  if (rO0.error) throw new Error(`OTS engine(0) error: ${rO0.error}`)
  const dO0 = rO0.detail as any
  const rO = await calculatePayrollWithRules(ots.id, monthDate, CL_A, OTS_CFG, {
    resignedAtOverride: CUTOFF_O,
    resignSettlement: { annualLeavePay: 0, noticePay: 0, tbDeduction: 1000, excessRestDeduction: 1680 },
  })
  if (rO.error) throw new Error(`OTS engine error: ${rO.error}`)
  const dO = rO.detail as any
  {
    check('#15 setup：120 分 OT → otPay > 0（gross > 4200）', (dO0.timebank?.otMinutes ?? 0) === 120 && dO0.grossPay > 4200, `otMin=${dO0.timebank?.otMinutes} gross0=${dO0.grossPay}`)
    check('#15 OT 重算路徑：gross(⑤=1680) = gross(⑤=0) − 1680（OT 重算覆寫後 ⑤ 照計）', near(dO.grossPay, Math.round((dO0.grossPay - 1680) * 100) / 100), `gross0=${dO0.grossPay} gross1680=${dO.grossPay}`)
    const expectMpf = calcMPF(dO.grossPay, { enabled: true, rate: 0.05, min: 7100, max: 30000 }, ctxO)
    check('#15 OT 重算路徑 mpf = calcMPF(最終 gross)（同主路徑口徑）', near(dO.mpf, expectMpf), `mpf=${dO.mpf} expect=${expectMpf}`)
    check('#14 兩扣款未合併：⑤ 喺 gross（差恰 1680）、⑥ 喺 net（net = gross − mpf − 1000）',
      dO.grossPay !== dO0.grossPay && near(dO.grossPay, dO0.grossPay - 1680) && near(dO.netPay, dO.grossPay - dO.mpf - 1000),
      `gross=${dO0.grossPay}→${dO.grossPay} net=${dO.netPay} mpf=${dO.mpf}（若合併 net/基數會錯）`)
  }

  // ═══ #18 已批年假唔計入非工作日（ALB）══════════════════════════
  console.log('── ALB 預覽（#18：9/11 已批年假 1 日）──')
  {
    const p = await preview(alb.id, '2026-09-14')
    const xr = p.settlement.excessRest
    check('#18 已批年假 1 日唔計入非工作日（實放 5 = 14 − 8 − 1）', xr?.actualRestDays === 5 && xr?.paidLeaveDays === 1, `xr=${JSON.stringify(xr)}`)
    check('#18 扣款 = 592.67（excess 1.27 × 466.67；唔係無假嘅 1,059.33）', xr?.excessDays === 1.27 && xr?.amount === 592.67, `xr=${JSON.stringify(xr)}`)
  }

  // ═══ #19 公眾假期唔計入非工作日（PHB：9/19 中秋翌日）════════════
  console.log('── PHB 預覽（#19：9/19 PH 喺受僱期內）──')
  {
    const p = await preview(phb.id, '2026-09-25')
    const xr = p.settlement.excessRest
    check('#19 公眾假期 1 日唔計入非工作日（實放 14 = 25 − 10 − 1）', xr?.actualRestDays === 14 && xr?.publicHolidayDays === 1, `xr=${JSON.stringify(xr)}`)
    check('#19 扣款 = 3,420.67（excess 7.33 × 466.67；唔係無PH嘅 3,887.33）', xr?.entitledRestDays === 6.67 && xr?.excessDays === 7.33 && xr?.amount === 3420.67, `xr=${JSON.stringify(xr)}`)
  }

  // fixture 留低俾 UI e2e（sweep 由 --sweep 或下次 self-heal 處理）
  fs.writeFileSync('/tmp/emp-excessrest-fixture.json', JSON.stringify({
    pfx: PFX, lunaId: luna.id, cc2Id: cc2.id, otsId: ots.id, ownerToken: OWNER_TOKEN,
    lastDay: LAST_DAY,
    expect: { cashout: '245.88', relevant: '2,765.88', mpf: '138.29', excess: '1,680.00', est: '2,627.59' },
  }, null, 2))

  console.log(`\n═══ RESULT: PASS=${pass} FAIL=${fail} ═══`)
  if (fails.length) { for (const f of fails) console.log(`  ✖ ${f}`) }
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); prisma.$disconnect().finally(() => process.exit(1)) })

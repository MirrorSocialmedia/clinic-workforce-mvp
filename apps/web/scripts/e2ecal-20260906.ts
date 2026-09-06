/**
 * cwm-caldayratio-20260906 — T5 e2e（in-process，跟 mpf60 模式）
 *
 * Run:
 *   set -a && . ./.env.development && set +a && npx tsx scripts/e2ecal-20260906.ts
 *   （主跑：純函數格 + 在職 cohort deep-equal + engine 預覽；fixture 留低俾 UI e2e）
 *   → UI e2e（e2ecal-ui-20260906.ts，要 dev server :3000）
 *   set -a && . ./.env.development && set +a && npx tsx scripts/e2ecal-20260906.ts --sweep
 *   （掃 e2cal 前綴全部 fixture → 0 殘留）
 *
 * 格（MD §3 + CEO 錨點）：
 *  純函數：#3 該月未入職 0 / #5 10 日含頭含尾 / #7 9/16 入 15/30 / #8 2 月 28 日
 *          #10 排休息日月頭比例唔變 / #11 resignedAt 邊界最後工作日計入
 *          #13 MIN 2366.67 / #14 供 291.67 / #15 完整月 MIN 7100 / #16 MAX 30000 唔調
 *          #17 極低薪 $0 / #19 同一 helper（engine ratio ↔ MPF MIN ↔ display）
 *  engine：#1 在職 cohort（4 synthetic + 4 真實）deep-equal /tmp/emp-caldayratio-before.json（生死格）
 *          #4 Selina $5,833.33（10/30）/ #6 CC2 全月薪 / #9 刪更後 preview 唔變（唔查更表）
 *          #18 OT 重算路徑 = 主路徑 / #22 扣薪日率仍 ÷22
 *  靜態：#2 return 1 短路先於 hkDaysInMonth / #20 兩個 helper 已剷 / #21 countWorkingDaysInRange 冇孤兒
 *
 * fixtures 全 synthetic 零 PII（前綴 e2cal + 秒戳；cohort e2calb），做完 sweep 0 殘留。
 * ⚠️ 生死格口徑：金額一分唔變；employedRatioDetail 分子分母改【曆日口徑】係有意（22/22 → 30/30），
 *   deep-equal 前 normalize 呢兩個欄（value 保留比較）。
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createToken } from '../src/lib/auth'
import { calculatePayrollWithRules, calcMPF, resolveEmployedRatio } from '../src/lib/payroll-engine'
import { adjustMpfMinForPeriod, employedDaysInMpfPeriod } from '../src/lib/mpf-exemption'
import { calcMpfDisplay } from '../src/lib/settlement-utils'
import { countHKDaysInclusive, hkDateStart, getMonthRange, toHKDateStr, hkDayOfWeek } from '../src/lib/hk-date'
import { buildCohort, captureCohort, sweepCohort, PFX as COHORT_PFX, CFG } from './emp-caldayratio-shared'
import { GET as resignPreviewGet } from '../src/app/api/employees/[id]/resign-preview/route'

const prisma = new PrismaClient()
const S = String(Math.floor(Date.now() / 1000))
const PFX = `e2cal${S}` // fixture 前綴（cuid 形 lowercase alnum ≥20）
const E = (suf: string) => `${PFX}${suf}`

const MONTH = '2026-09'
const JOIN = '2026-07-01'      // Selina 入職（≥60 日前，過 60 日規則 + 免供款期）
const LAST_DAY = '2026-09-10'  // 最後工作日 → 受僱 9/1–9/10（10 日，含頭含尾）
const CUTOFF = new Date(hkDateStart(LAST_DAY).getTime() + 86400000) // resignedAt 口徑（翌日 HK 午夜）

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
    await sweepAll('e2cal')
    const c1 = await prisma.employee.count({ where: { id: { startsWith: 'e2cal' } } })
    const c2 = await prisma.user.count({ where: { id: { startsWith: 'e2cal' } } })
    fs.rmSync('/tmp/emp-caldayratio-fixture.json', { force: true })
    console.log(`sweep 完成：emp=${c1} user=${c2}（必須 0/0）`)
    await prisma.$disconnect()
    process.exit(c1 === 0 && c2 === 0 ? 0 : 1)
  }

  const today = toHKDateStr(new Date())
  if (today.slice(0, 7) !== MONTH) { console.error(`✖ e2e 只喺 ${MONTH} 有效（日期鎖死 9 月），而家 ${today} — 拒絕`); process.exit(1) }
  await selfHealTriggers()
  // self-heal：洗上次殘留 fixture（冪等）
  const stale = await prisma.employee.count({ where: { id: { startsWith: 'e2cal' } } })
  if (stale > 0) { console.log(`── self-heal：洗殘留 fixture（${stale} 人）──`); await sweepAll('e2cal') }
  fs.rmSync('/tmp/emp-caldayratio-fixture.json', { force: true })

  const clinics = await prisma.clinic.findMany({ orderBy: { id: 'asc' }, take: 1 })
  const owner = await prisma.user.findFirst({ where: { email: 'owner@clinic.demo' } })
  if (!clinics[0] || !owner) { console.error('✖ seed missing (clinic/owner)'); process.exit(1) }
  CL_A = clinics[0].id; OWNER_ID = owner.id
  OWNER_TOKEN = createToken({ userId: owner.id, role: owner.role, clinics: [], tokenVersion: owner.tokenVersion ?? 0 })
  const tmp = (await prisma.shiftTemplate.findFirst({ where: { name: '全日' } }))!

  const { start: monthStart, end: monthEnd } = getMonthRange(hkd('2026-09-01'))
  const monthDate = hkd('2026-09-01')
  const selinaCtx = { joinDate: hkd(JOIN), periodMonth: monthDate, lastDay: hkd(LAST_DAY) }

  // ═══ 純函數層（無 DB）══════════════════════════════════════════
  console.log('── 純函數：曆日比例 + MPF pro-rate ──')
  // #3 該月完全未入職 → 0
  check('#3a 該月完全未入職（10/5 入）ratio=0', resolveEmployedRatio(hkd('2026-10-05'), null, monthStart, monthEnd, monthDate) === 0, `got ${resolveEmployedRatio(hkd('2026-10-05'), null, monthStart, monthEnd, monthDate)}`)
  check('#3b 該月前已離職（8/1 入 9/1 走）ratio=0', resolveEmployedRatio(hkd('2026-08-01'), hkd('2026-09-01'), monthStart, monthEnd, monthDate) === 0, `got ${resolveEmployedRatio(hkd('2026-08-01'), hkd('2026-09-01'), monthStart, monthEnd, monthDate)}`)
  // #5 含頭含尾
  check('#5 countHKDaysInclusive(9/1,9/10) = 10（含頭含尾）', countHKDaysInclusive(hkd('2026-09-01'), hkd('2026-09-10')) === 10, `got ${countHKDaysInclusive(hkd('2026-09-01'), hkd('2026-09-10'))}`)
  check('#4/#5 Selina ratio = 10/30', near(resolveEmployedRatio(hkd(JOIN), CUTOFF, monthStart, monthEnd, monthDate), 10 / 30), `got ${resolveEmployedRatio(hkd(JOIN), CUTOFF, monthStart, monthEnd, monthDate)}`)
  // #7 月中入職
  check('#7 9/16 入職（在職）= 15/30', near(resolveEmployedRatio(hkd('2026-09-16'), null, monthStart, monthEnd, monthDate), 15 / 30), `got ${resolveEmployedRatio(hkd('2026-09-16'), null, monthStart, monthEnd, monthDate)}`)
  // #8 2 月 28 日分母
  const feb = getMonthRange(hkd('2026-02-10'))
  check('#8 2 月分母 28（2/10 入 → 19/28）', near(resolveEmployedRatio(hkd('2026-02-10'), null, feb.start, feb.end, hkd('2026-02-01')), 19 / 28), `got ${resolveEmployedRatio(hkd('2026-02-10'), null, feb.start, feb.end, hkd('2026-02-01'))}`)
  // #10 曆日唔受排班影響（新簽名根本冇 rest config — Selina 10/30 同 #4 同一值）
  check('#10 排晒休息日月頭比例唔變（曆日）', near(resolveEmployedRatio(hkd(JOIN), CUTOFF, monthStart, monthEnd, monthDate), 10 / 30), 'calendar ratio 唔理排班')
  // #11 resignedAt 邊界：最後工作日計入（9/20 入、10/1 走 → 9/20–9/30 = 11 日）
  check('#11 邊界 9/20–9/30 = 11 日（最後工作日計入）', near(resolveEmployedRatio(hkd('2026-09-20'), hkd('2026-10-01'), monthStart, monthEnd, monthDate), 11 / 30), `got ${resolveEmployedRatio(hkd('2026-09-20'), hkd('2026-10-01'), monthStart, monthEnd, monthDate)}`)

  console.log('── 純函數：MPF MIN pro-rate ──')
  check('#13 MIN = 7100×10/30 = 2366.67', adjustMpfMinForPeriod(7100, selinaCtx) === 2366.67, `got ${adjustMpfMinForPeriod(7100, selinaCtx)}`)
  check('#14 有關入息 5833.33 > MIN → 供 291.67', near(calcMPF(5833.33, { enabled: true, rate: 0.05, min: 7100, max: 30000 }, selinaCtx), 291.67), `got ${calcMPF(5833.33, { enabled: true, rate: 0.05, min: 7100, max: 30000 }, selinaCtx)}`)
  check('#15a 完整月（lastDay 9/30）MIN 維持 7100', adjustMpfMinForPeriod(7100, { joinDate: hkd('2025-01-01'), periodMonth: monthDate, lastDay: hkd('2026-09-30') }) === 7100, `got ${adjustMpfMinForPeriod(7100, { joinDate: hkd('2025-01-01'), periodMonth: monthDate, lastDay: hkd('2026-09-30') })}`)
  check('#15b 在職全月（無 lastDay）MIN 7100 + 供 1000', adjustMpfMinForPeriod(7100, { joinDate: hkd('2025-01-01'), periodMonth: monthDate }) === 7100 && near(calcMPF(20000, { enabled: true, rate: 0.05, min: 7100, max: 30000 }, { joinDate: hkd('2025-01-01'), periodMonth: monthDate }), 1000), `min=${adjustMpfMinForPeriod(7100, { joinDate: hkd('2025-01-01'), periodMonth: monthDate })}`)
  check('#15c 月中入職在職 MIN pro-rate（9/16 入 → 3550）', adjustMpfMinForPeriod(7100, { joinDate: hkd('2026-09-16'), periodMonth: monthDate }) === 3550, `got ${adjustMpfMinForPeriod(7100, { joinDate: hkd('2026-09-16'), periodMonth: monthDate })}`)
  check('#16 MAX 30000 唔按比例（10 日賺 33333.33 → 1500 封頂）', near(calcMPF(33333.33, { enabled: true, rate: 0.05, min: 7100, max: 30000 }, selinaCtx), 1500), `got ${calcMPF(33333.33, { enabled: true, rate: 0.05, min: 7100, max: 30000 }, selinaCtx)}`)
  check('#17 極低薪 10 日賺 2000 < 2366.67 → 0', calcMPF(2000, { enabled: true, rate: 0.05, min: 7100, max: 30000 }, selinaCtx) === 0, `got ${calcMPF(2000, { enabled: true, rate: 0.05, min: 7100, max: 30000 }, selinaCtx)}`)
  check('#19 同一 helper：employedDaysInMpfPeriod = countHKDaysInclusive = 10', employedDaysInMpfPeriod(selinaCtx) === countHKDaysInclusive(hkd('2026-09-01'), hkd('2026-09-10')) && employedDaysInMpfPeriod(selinaCtx) === 10, `got ${employedDaysInMpfPeriod(selinaCtx)}`)
  // #19 display ↔ engine 一致
  const disp14 = calcMpfDisplay(JOIN, LAST_DAY, 5833.33)
  check('#19 結算卡 display = engine（291.67，無零理由）', near(disp14.employee, 291.67) && disp14.zeroReason === null, `disp=${JSON.stringify(disp14)}`)
  const disp17 = calcMpfDisplay(JOIN, LAST_DAY, 2000)
  check('#17 display 零理由「低於 $2,366.67（不完整糧期按比例）」', disp17.employee === 0 && !!disp17.zeroReason && disp17.zeroReason.includes('低於 $2,366.67') && disp17.zeroReason.includes('不完整糧期按比例'), `reason=${disp17.zeroReason}`)
  const disp15 = calcMpfDisplay('2025-01-01', '2026-09-30', 2000)
  check('#15 display 完整月零理由「低於 $7,100」（無按比例字眼）', disp15.employee === 0 && !!disp15.zeroReason && disp15.zeroReason.includes('低於 $7,100') && !disp15.zeroReason.includes('按比例'), `reason=${disp15.zeroReason}`)

  console.log('── 靜態：#2 #20 #21 ──')
  {
    const engineSrc = fs.readFileSync('src/lib/payroll-engine.ts', 'utf8')
    const shortIdx = engineSrc.indexOf('if (from <= monthStart && to >= monthEnd) return 1')
    const hkIdx = engineSrc.indexOf('const total = hkDaysInMonth(monthDate)')
    check('#2 完整月 return 1 短路先於 hkDaysInMonth（生死格）', shortIdx > -1 && hkIdx > -1 && shortIdx < hkIdx, `short=${shortIdx} hk=${hkIdx}`)
    const g = (p: string) => execSync(`grep -rn "${p}" src/ || true`, { encoding: 'utf8' }).trim()
    check('#20 countRosterDaysInRange 已剷（src 零命中）', g('countRosterDaysInRange') === '', g('countRosterDaysInRange').slice(0, 200))
    check('#20 buildRosterDays 已剷（src 零命中）', g('buildRosterDays') === '', g('buildRosterDays').slice(0, 200))
    const cwdSrc = execSync(`grep -rc "countWorkingDaysInRange" src/ | grep -v ":0$" || true`, { encoding: 'utf8' }).trim()
    check('#21 countWorkingDaysInRange src 只餘定義（payroll-engine.ts ×1）', cwdSrc === 'src/lib/payroll-engine.ts:1', `got=${JSON.stringify(cwdSrc)}`)
  }

  // ═══ #1 生死格：在職 cohort deep-equal（BEFORE 基準）════════════
  console.log('── #1 在職 cohort deep-equal（e2calb 前綴 + 4 真實在職）──')
  let capAfter: Record<string, any> = {}
  {
    const before = JSON.parse(fs.readFileSync('/tmp/emp-caldayratio-before.json', 'utf8'))
    const ids = await buildCohort()
    capAfter = await captureCohort(ids)
    await sweepCohort(COHORT_PFX)
    // normalize：employedRatioDetail 分子分母改曆日口徑係有意 — 只比 value
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
    check('#1 在職 8 員工（4 synthetic + 4 真實）9 月計糧全欄一分唔變（生死格）', same, diffs.join('; '))
    const ratioOk = Object.entries(capAfter).every(([, v]: any) => v?.detail?.employedRatioDetail?.value === 1 && v?.detail?.employedRatioDetail?.numerator === 30 && v?.detail?.employedRatioDetail?.denominator === 30)
    check('#1 ratio 快照轉曆日口徑（全 8 人 30/30、value=1）', ratioOk, JSON.stringify(Object.fromEntries(Object.entries(capAfter).map(([k, v]: any) => [k, v?.detail?.employedRatioDetail]))))
    // #22 扣薪日率仍 ÷22（R4：無薪假 1 日扣 12000/22）
    const r4 = capAfter['R4']
    check('#22 扣薪日率仍 ÷22（R4 dailyWage=545.45、無薪假扣 545.45）', r4 && near(r4.detail.salary.dailyWage, 545.45) && near(r4.deduction, 545.45), `dailyWage=${r4?.detail?.salary?.dailyWage} deduction=${r4?.deduction}`)
  }

  // ═══ fixtures（synthetic，零 PII）═══════════════════════════════
  console.log('── seed fixtures（e2cal 前綴）──')
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
    await prisma.shift.createMany({ data: days.map(d => ({ employeeId: empId, clinicId: CL_A, templateId: tmp.id, date: hkd(d), startTime: new Date(`${d}T09:00:00+08:00`), endTime: new Date(`${d}T18:00:00+08:00`), status: 'CONFIRMED' as const, createdBy: OWNER_ID })) })
  }
  const mkPunch = async (empId: string, d: string, hhmm: string, type: 'CLOCK_IN' | 'CLOCK_OUT') => {
    await prisma.punchRecord.create({ data: { employeeId: empId, clinicId: CL_A, punchTime: new Date(`${d}T${hhmm}:00+08:00`), punchType: type, source: 'SYSTEM' } })
  }

  // SEL：入職 7/1、最後工作日 9/10（10 日）— 9/1–9/10 排晒更（連周末）做 #9 刪更實驗
  const selDays = Array.from({ length: 10 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`)
  const sel = await mkEmp((await mkUser('E2E CAL Selina', `e2cal${S}s1`)).id, JOIN)
  await mkRule(sel.id, 17500); await mkShifts(sel.id, selDays)
  await mkPunch(sel.id, '2026-09-01', '09:00', 'CLOCK_IN'); await mkPunch(sel.id, '2026-09-01', '18:00', 'CLOCK_OUT')
  await mkPunch(sel.id, '2026-09-02', '09:00', 'CLOCK_IN'); await mkPunch(sel.id, '2026-09-02', '18:00', 'CLOCK_OUT')
  // CC2：做足 9 月（最後工作日 9/30）— 22 個 weekday 更
  const cc2 = await mkEmp((await mkUser('E2E CAL CC2', `e2cal${S}c2`)).id, JOIN)
  await mkRule(cc2.id, 17500)
  const cc2Days: string[] = []
  for (let i = 1; i <= 30; i++) { const dd = `2026-09-${String(i).padStart(2, '0')}`; if (![0, 6].includes(hkDayOfWeek(dd))) cc2Days.push(dd) }
  await mkShifts(cc2.id, cc2Days)
  // OTS：入職 7/1、最後工作日 9/10 + OT 打卡（9/1 OUT 20:00 → 120 分 OT）→ #18 OT 重算路徑
  const ots = await mkEmp((await mkUser('E2E CAL OTS', `e2cal${S}o1`)).id, JOIN)
  await mkRule(ots.id, 17500); await mkShifts(ots.id, selDays.filter(d => !['2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'].includes(d)))
  await mkPunch(ots.id, '2026-09-01', '09:00', 'CLOCK_IN'); await mkPunch(ots.id, '2026-09-01', '20:00', 'CLOCK_OUT')

  // ═══ #4 #5 Selina 預覽（resign-preview API，lastDay 9/10）═══════
  console.log('── #4 #5 #9 Selina 預覽 ──')
  {
    const p1 = await preview(sel.id, LAST_DAY)
    const st = p1.settlement
    check('#4 Selina 當月工資 = $5,833.33（10/30）', st.monthWage?.source === 'preview' && near(st.monthWage?.basePay ?? -1, 5833.33), `mw=${JSON.stringify(st.monthWage)}`)
    check('#5 ratio 分子 10 ÷ 分母 30（含頭含尾曆日）', st.monthWageRatio?.numerator === 10 && st.monthWageRatio?.denominator === 30 && near(st.monthWageRatio?.value ?? -1, 10 / 30), `ratio=${JSON.stringify(st.monthWageRatio)}`)
    // #9 刪晒該月更 → 重預覽 → 數字唔變（唔查更表；舊 roster 版分子會跌去 0）
    const nShifts = await prisma.shift.deleteMany({ where: { employeeId: sel.id, date: { gte: hkd('2026-09-01'), lt: hkd('2026-10-01') } } })
    const p2 = await preview(sel.id, LAST_DAY)
    const st2 = p2.settlement
    check('#9 刪更後重算數字唔變（唔查更表）', near(st2.monthWage?.basePay ?? -1, 5833.33) && st2.monthWageRatio?.numerator === 10 && st2.monthWageRatio?.denominator === 30, `after-delete mw=${JSON.stringify(st2.monthWage)} ratio=${JSON.stringify(st2.monthWageRatio)} (deleted ${nShifts.count} shifts)`)
  }

  // ═══ #6 CC2 全月薪 ════════════════════════════════════════════
  {
    const p = await preview(cc2.id, '2026-09-30')
    const st = p.settlement
    check('#6 CC2 做足 9 月 = 全月薪 $17,500（30/30）', near(st.monthWage?.basePay ?? -1, 17500) && st.monthWageRatio?.numerator === 30 && st.monthWageRatio?.denominator === 30, `mw=${JSON.stringify(st.monthWage)} ratio=${JSON.stringify(st.monthWageRatio)}`)
  }

  // ═══ #18 OT 重算路徑 = 主路徑（engine direct）══════════════════
  {
    const r = await calculatePayrollWithRules(ots.id, monthDate, CL_A, CFG(17500), { resignedAtOverride: CUTOFF })
    if (r.error) throw new Error(`OTS engine error: ${r.error}`)
    const rr = r as any
    const expectMpf = calcMPF((rr.detail as any).grossPay, { enabled: true, rate: 0.05, min: 7100, max: 30000 }, selinaCtx)
    check('#18 OT 重算路徑 mpf = 主路徑 calcMPF（final gross）', near((rr.detail as any).mpf, expectMpf) && (rr.detail as any).mpf > 0, `mpf=${rr.detail?.mpf} expect=${expectMpf} gross=${rr.detail?.grossPay}`)
    check('#18 sanity：OT 120 分存在（timebank 計到）+ mpf > 0', (rr.detail as any).timebank?.otMinutes === 120 && (rr.detail as any).mpf > 0, `tbOt=${rr.detail?.timebank?.otMinutes} mpf=${rr.detail?.mpf} gross=${rr.detail?.grossPay}`)
  }

  // fixture 留低俾 UI e2e（sweep 由 --sweep 或下次 self-heal 處理）
  fs.writeFileSync('/tmp/emp-caldayratio-fixture.json', JSON.stringify({
    pfx: PFX, selId: sel.id, cc2Id: cc2.id, otsId: ots.id, ownerToken: OWNER_TOKEN,
    lastDay: LAST_DAY, expectEst: '5,541.66',
  }, null, 2))

  console.log(`\n═══ RESULT: PASS=${pass} FAIL=${fail} ═══`)
  if (fails.length) { for (const f of fails) console.log(`  ✖ ${f}`) }
  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch(e => { console.error(e); prisma.$disconnect().finally(() => process.exit(1)) })

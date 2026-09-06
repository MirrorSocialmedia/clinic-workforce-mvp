/**
 * e2e-resignroster-20260905 — [cwm-resignroster-20260905] 生死格 26 格 in-process 全數驗證
 *
 * Run: set -a && . ./.env.development && set +a && npx tsx scripts/e2e-resignroster-20260905.ts
 *
 * 老細拍板：打卡全唔入計算（預覽 + 正式計糧）— 分子淨係用【實際更表 + 已批帶薪非 REST_DAY 假期】。
 *
 * Fixtures（全 synthetic 零 PII，id 前綴 e2erg，做完 sweep 0 殘留）:
 *  - CL_A / CL_B = 頭兩間 clinic（scope gate 鏈 Employee.homeClinicId）
 *  - A1  全月在職無更無假（2025-01 入）          → #1 #2（8 月計糧一分唔變 + 唔查更表）
 *  - C   全月在職 22 更                            → #23（完整月份 $17,500）
 *  - P   在職只打卡無更（override 9/11）           → #15（打卡日唔入分子 → 0）
 *  - J   月中入職 9/10 + 2 更                       → #24（2/22 → $1,590.91）
 *  - E24 排 24 更（override 9/24）                  → #3（24/22 → min 封頂 1）
 *  - E10 更+已批年假 / E11 更+REST_DAY 假 / E12 更+無薪假 / E13 CANCELLED 更 / E14 同日雙更 → #10-14 分子組成
 *  - H   時薪 $100/h + 8h 打卡                      → #25（時薪唔經 ratio）
 *  - S   Selina：2026-06-01 入、$17,500、9 月實排 7 更（9/1,2,5,6,7,8,9）、
 *        三筆已批 REST_DAY（9/3,9/4,9/10）、最後工作日 9/11   → #5-9 #16-18
 *  - S2  9/1 入、3 更（9/1,2,5）+ 打卡 + TB −540min，lastDay=today → #20 #22（結算 notice 7 日）
 *  - S3  9/1 入、3 更（9/1,2,3），lastDay 9/3 → 重結算 9/2      → #21（snapshot 覆蓋 + audit）
 *  - #4  resolveEmployedRatio 純函數：分母=0 → return 1 + warn
 */
import { PrismaClient } from '@prisma/client'
import { NextRequest } from 'next/server'
import { createToken } from '../src/lib/auth'
import { calculatePayrollWithRules, generatePayrollRun, resolveEmployedRatio } from '../src/lib/payroll-engine'
import { hkDateStart, toHKDateStr } from '../src/lib/hk-date'
import { GET as resignPreviewGet } from '../src/app/api/employees/[id]/resign-preview/route'
import { POST as resignPost } from '../src/app/api/employees/[id]/resign/route'
import { POST as resignSettlePost } from '../src/app/api/employees/[id]/resign-settle/route'
import { POST as payrollPreviewPost } from '../src/app/api/payroll-runs/preview/route'

const prisma = new PrismaClient()

const S = String(Math.floor(Date.now() / 1000))
const E = (suf: string) => `e2ergr${S}${suf}` // e2erg 前綴 + 20+ chars（normalizeRoute cuid 形）

const today = toHKDateStr(new Date())
const TODAY_MONTH = today.slice(0, 7)
const S_LAST_DAY = '2026-09-11'   // Selina（MD 實數）
const S_JOIN = '2026-06-01'
const S_SHIFT_DATES = ['2026-09-01', '2026-09-02', '2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08', '2026-09-09']
const S_REST_DAY_DATES = ['2026-09-03', '2026-09-04', '2026-09-10']

let OWNER_ID = ''
let OWNER_TOKEN = ''
let CL_A = ''
let CL_B = ''
let TMP_ID = ''
let selinaPreviewBasePay: number | null = null
const LT_REST = { id: '' }
const LT_ANNUAL = { id: '' }
const LT_UNPAID = { id: '' }
const ids: string[] = []
const runIds: string[] = []

// ── 記帳 ────────────────────────────────────────────────────────────
let pass = 0
let fail = 0
const fails: string[] = []
function check(name: string, cond: boolean, detail: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; fails.push(`${name} — ${detail}`); console.log(`  ❌ ${name} — ${detail}`) }
}
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) < tol
const r2 = (x: number) => Math.round(x * 100) / 100

const hkd = (d: string) => new Date(`${d}T00:00:00+08:00`)
const cutoffOf = (lastDay: string) => new Date(hkDateStart(lastDay).getTime() + 86400000) // 翌日 HK 午夜
function mkReq(pathStr: string, opts: { method?: string; body?: any } = {}) {
  const headers: Record<string, string> = { 'cookie': `session=${OWNER_TOKEN}` }
  if (opts.body) headers['content-type'] = 'application/json'
  return new NextRequest(`http://localhost:3000${pathStr}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
}

// config：月薪 $17,500、rest 週六日（9 月分母 = 22）、MPF off
const CFG_M: any = { base_type: 'monthly', monthly_salary: 17500, modifiers: { working_days: { rest_days: [6, 0] } } }
const CFG_H: any = { base_type: 'hourly', hourly_rate: 100 }

async function mkUser(name: string, phone: string) {
  const u = await prisma.user.create({ data: { id: E(`u${Math.random().toString(36).slice(2, 6)}`), name, phone, password: 'x'.repeat(60), status: 'ACTIVE', role: 'EMPLOYEE' } })
  ids.push(u.id)
  return u
}
async function mkEmp(uid: string, joinDate: string, clinicId: string) {
  const e = await prisma.employee.create({ data: { id: E(`e${Math.random().toString(36).slice(2, 6)}`), userId: uid, joinDate: hkd(joinDate), status: 'ACTIVE', homeClinicId: clinicId } })
  ids.push(e.id)
  await prisma.employeeClinic.create({ data: { employeeId: e.id, clinicId, isPrimary: true } })
  return e
}
async function mkPayRule(empId: string, cfg: any) {
  await prisma.payRule.create({ data: { employeeId: empId, payType: 'MONTHLY', baseAmount: cfg.monthly_salary ?? 0, configJson: JSON.stringify(cfg), effectiveFrom: hkd('2025-01-01'), isActive: true, createdBy: OWNER_ID } })
}
async function mkShifts(empId: string, clinicId: string, spec: Array<{ d: string; h1: number; h2: number; status?: 'CONFIRMED' | 'CANCELLED' }>) {
  await prisma.shift.createMany({ data: spec.map(s => ({
    employeeId: empId, clinicId, templateId: TMP_ID,
    status: (s.status ?? 'CONFIRMED') as 'CONFIRMED' | 'CANCELLED', createdBy: OWNER_ID,
    date: hkd(s.d),
    startTime: new Date(`${s.d}T${String(s.h1).padStart(2, '0')}:00:00+08:00`),
    endTime: new Date(`${s.d}T${String(s.h2).padStart(2, '0')}:00:00+08:00`),
  })) })
}
async function mkLeave(empId: string, lt: { id: string }, d: string) {
  await prisma.leaveRequest.create({ data: {
    employeeId: empId, leaveTypeId: lt.id, startDate: hkd(d), endDate: hkd(d), days: 1,
    status: 'APPROVED', approverId: OWNER_ID, approvedAt: hkd('2026-09-01'),
  } })
}
async function mkPunch(empId: string, clinicId: string, d: string, hhmm: string, type: 'CLOCK_IN' | 'CLOCK_OUT') {
  await prisma.punchRecord.create({ data: {
    employeeId: empId, clinicId, punchTime: new Date(`${d}T${hhmm}:00+08:00`),
    punchType: type, source: 'SYSTEM',
  } })
}

/** 引擎直算（同 preview route 同一來源）— 傳 cfg 唔落 DB 改寫 */
async function engineDirect(empId: string, month: string, clinicId: string, cfg: any, lastDayOverride?: string) {
  const monthDate = new Date(`${month}-01T00:00:00+08:00`)
  const result = await calculatePayrollWithRules(empId, monthDate, clinicId, cfg, lastDayOverride ? { resignedAtOverride: cutoffOf(lastDayOverride) } : undefined)
  if (result.error) throw new Error(`engine error: ${result.error}`)
  return result as any
}

async function sweep() {
  const empIds = ids
  // 先洗 run 下屬（resignSettlementJson 注入行）
  for (const rid of runIds) {
    await prisma.payrollItem.deleteMany({ where: { runId: rid } })
    await prisma.payrollRun.deleteMany({ where: { id: rid } })
  }
  await prisma.timeBankEntry.deleteMany({ where: { employeeId: { in: empIds } } })
  await prisma.timeBank.deleteMany({ where: { employeeId: { in: empIds } } })
  // PunchRecord / AuditLog 係 append-only（trigger 擋 DELETE/UPDATE）— e2erg 測試行清理：
  // temporarily disable → delete → finally enable（self-heal：開工前必檢查 trigger 已啟用）
  // ⚠️ AuditLog.targetEmployeeId FK = ON DELETE SET NULL → 唔先清 AuditLog 就會觸發
  //    AuditLog UPDATE → 撞 no_mutate_audit → Employee DELETE 失敗（實測事故）
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
  await prisma.user.deleteMany({ where: { id: { in: empIds } } })
}

async function main() {
  // self-heal：上次 crash 可能留低 disabled trigger — 確保 append-only 保護生效
  const trigs = await prisma.$queryRawUnsafe<Array<{ name: string; en: string }>>(`SELECT tgname AS name, tgenabled AS en FROM pg_trigger WHERE tgname IN ('no_mutate_punch','no_mutate_audit')`)
  for (const t of trigs) {
    if (t.en !== 'O') {
      const tbl = t.name === 'no_mutate_punch' ? '"PunchRecord"' : '"AuditLog"'
      console.log(`⚠️ ${t.name} trigger 未啟用（上次 crash 殘留）— 重新啟用`)
      await prisma.$executeRawUnsafe(`ALTER TABLE ${tbl} ENABLE TRIGGER ${t.name}`)
    }
  }

  if (TODAY_MONTH !== '2026-09') {
    console.error(`✖ e2e 只喺 2026-09 有效（Selina/S2/S3 日期鎖死 9 月），而家 ${TODAY_MONTH} — 拒絕執行`);
    process.exit(1)
  }

  // ── seeds lookup ────────────────────────────────────────────────
  const clinics = await prisma.clinic.findMany({ orderBy: { id: 'asc' }, take: 2 })
  if (clinics.length < 2) { console.error('✖ 少於 2 間 clinic'); process.exit(1) }
  CL_A = clinics[0].id
  CL_B = clinics[1].id
  const owner = await prisma.user.findFirst({ where: { email: 'owner@clinic.demo' } })
  if (!owner) { console.error('✖ seed owner（owner@clinic.demo）唔存在'); process.exit(1) }
  OWNER_ID = owner.id
  OWNER_TOKEN = createToken({ userId: owner.id, role: owner.role, clinics: [], tokenVersion: owner.tokenVersion ?? 0 })
  TMP_ID = (await prisma.shiftTemplate.findFirst({ where: { name: '全日' } }))!.id
  LT_REST.id = (await prisma.leaveType.findUnique({ where: { systemKey: 'REST_DAY' } }))!.id
  LT_ANNUAL.id = (await prisma.leaveType.findUnique({ where: { systemKey: 'ANNUAL_LEAVE' } }))!.id
  const ltUnpaid = await prisma.leaveType.findFirst({ where: { isPaid: false, systemKey: null } })
  if (!ltUnpaid) { console.error('✖ 無薪假 LeaveType 唔存在'); process.exit(1) }
  LT_UNPAID.id = ltUnpaid.id

  // ── seed fixtures ───────────────────────────────────────────────
  console.log('── seed fixtures（synthetic，零 PII）──')
  // A1：全月在職（#1 #2）
  const eA1 = await mkEmp((await mkUser('E2E RG A1', `e2erg${S}a1`)).id, '2025-01-01', CL_A)
  await mkPayRule(eA1.id, CFG_M)
  // C：全月在職 22 更（#23）
  const eC = await mkEmp((await mkUser('E2E RG C', `e2erg${S}c1`)).id, '2025-09-01', CL_B)
  await mkPayRule(eC.id, CFG_M)
  await mkShifts(eC.id, CL_B, Array.from({ length: 22 }, (_, i) => ({ d: `2026-09-${String(i + 1).padStart(2, '0')}`, h1: 9, h2: 18 })))
  // P：只打卡無更（#15）
  const eP = await mkEmp((await mkUser('E2E RG P', `e2erg${S}p1`)).id, '2025-01-01', CL_B)
  await mkPayRule(eP.id, CFG_M)
  await mkPunch(eP.id, CL_B, '2026-09-02', '09:00', 'CLOCK_IN')
  // J：月中入職 9/10 + 2 更（#24）
  const eJ = await mkEmp((await mkUser('E2E RG J', `e2erg${S}j1`)).id, '2026-09-10', CL_B)
  await mkPayRule(eJ.id, CFG_M)
  await mkShifts(eJ.id, CL_B, [{ d: '2026-09-10', h1: 9, h2: 18 }, { d: '2026-09-11', h1: 9, h2: 18 }])
  // E24：排 24 更（#3）
  const e24 = await mkEmp((await mkUser('E2E RG E24', `e2erg${S}e24`)).id, '2026-09-01', CL_B)
  await mkPayRule(e24.id, CFG_M)
  await mkShifts(e24.id, CL_B, Array.from({ length: 24 }, (_, i) => ({ d: `2026-09-${String(i + 1).padStart(2, '0')}`, h1: 9, h2: 18 })))
  // E10-E14：分子組成（#10-14）
  const e10 = await mkEmp((await mkUser('E2E RG E10', `e2erg${S}e10`)).id, '2025-01-01', CL_B)
  await mkPayRule(e10.id, CFG_M)
  await mkShifts(e10.id, CL_B, [{ d: '2026-09-01', h1: 9, h2: 18 }])
  await mkLeave(e10.id, LT_ANNUAL, '2026-09-02')
  const e11 = await mkEmp((await mkUser('E2E RG E11', `e2erg${S}e11`)).id, '2025-01-01', CL_B)
  await mkPayRule(e11.id, CFG_M)
  await mkShifts(e11.id, CL_B, [{ d: '2026-09-01', h1: 9, h2: 18 }])
  await mkLeave(e11.id, LT_REST, '2026-09-02')
  const e12 = await mkEmp((await mkUser('E2E RG E12', `e2erg${S}e12`)).id, '2025-01-01', CL_B)
  await mkPayRule(e12.id, CFG_M)
  await mkShifts(e12.id, CL_B, [{ d: '2026-09-01', h1: 9, h2: 18 }])
  await mkLeave(e12.id, LT_UNPAID, '2026-09-02')
  const e13 = await mkEmp((await mkUser('E2E RG E13', `e2erg${S}e13`)).id, '2025-01-01', CL_B)
  await mkPayRule(e13.id, CFG_M)
  await mkShifts(e13.id, CL_B, [{ d: '2026-09-01', h1: 9, h2: 18 }, { d: '2026-09-02', h1: 9, h2: 18, status: 'CANCELLED' }])
  const e14 = await mkEmp((await mkUser('E2E RG E14', `e2erg${S}e14`)).id, '2025-01-01', CL_B)
  await mkPayRule(e14.id, CFG_M)
  await mkShifts(e14.id, CL_B, [{ d: '2026-09-01', h1: 9, h2: 13 }, { d: '2026-09-01', h1: 14, h2: 18 }])
  // H：時薪（#25）
  const eH = await mkEmp((await mkUser('E2E RG H', `e2erg${S}h1`)).id, '2025-01-01', CL_B)
  await mkPayRule(eH.id, CFG_H)
  await mkShifts(eH.id, CL_B, [{ d: '2026-09-02', h1: 9, h2: 17 }])
  await mkPunch(eH.id, CL_B, '2026-09-02', '09:00', 'CLOCK_IN')
  await mkPunch(eH.id, CL_B, '2026-09-02', '17:00', 'CLOCK_OUT')
  // S：Selina（#5-9 #16-18）
  const eS = await mkEmp((await mkUser('E2E RG Selina', `e2erg${S}s1`)).id, S_JOIN, CL_B)
  await mkPayRule(eS.id, CFG_M)
  await mkShifts(eS.id, CL_B, S_SHIFT_DATES.map(d => ({ d, h1: 9, h2: 18 })))
  for (const d of S_REST_DAY_DATES) await mkLeave(eS.id, LT_REST, d)
  // S2：結算 snapshot（#20 #22）— lastDay = today
  const eS2 = await mkEmp((await mkUser('E2E RG S2', `e2erg${S}s2`)).id, '2026-09-01', CL_A)
  await mkPayRule(eS2.id, CFG_M)
  await mkShifts(eS2.id, CL_A, [{ d: '2026-09-01', h1: 9, h2: 18 }, { d: '2026-09-02', h1: 9, h2: 18 }, { d: today, h1: 9, h2: 18 }])
  await mkPunch(eS2.id, CL_A, '2026-09-01', '08:58', 'CLOCK_IN')
  await mkPunch(eS2.id, CL_A, '2026-09-01', '18:02', 'CLOCK_OUT')
  await mkPunch(eS2.id, CL_A, '2026-09-02', '08:58', 'CLOCK_IN')
  await mkPunch(eS2.id, CL_A, '2026-09-02', '18:02', 'CLOCK_OUT')
  await mkPunch(eS2.id, CL_A, today, '08:58', 'CLOCK_IN')
  await mkPunch(eS2.id, CL_A, today, '18:02', 'CLOCK_OUT')
  // TB 欠款 −540min（明細行；引擎管 row）
  await prisma.timeBankEntry.create({ data: { employeeId: eS2.id, date: hkd(today), type: 'INIT_ADJUST', minutes: -540, note: 'e2erg seed debt', createdBy: OWNER_ID } })
  // S3：改 lastDay 重結算（#21）
  const eS3 = await mkEmp((await mkUser('E2E RG S3', `e2erg${S}s3`)).id, '2026-09-01', CL_A)
  await mkPayRule(eS3.id, CFG_M)
  await mkShifts(eS3.id, CL_A, [{ d: '2026-09-01', h1: 9, h2: 18 }, { d: '2026-09-02', h1: 9, h2: 18 }, { d: '2026-09-03', h1: 9, h2: 18 }])

  const month = '2026-09'

  // ═══ #4 分母=0 → return 1 + warn（純函數）════════════════════════
  console.log('── #4 分母=0 → 1 + warn ──')
  const warnSpy: string[] = []
  const origWarn = console.warn
  console.warn = (...a: any[]) => { warnSpy.push(a.join(' ')) }
  let ratio4 = 0
  try {
    // ★ 2026-09-06 [cwm-caldayratio]：resolveEmployedRatio 改曆日比例（第 5 參 = monthDate）— 本單前嘅分母=0 場景已唔存在
    ratio4 = resolveEmployedRatio(hkd('2026-09-10'), hkd('2026-09-20'), hkd('2026-09-01'), new Date('2026-09-30T23:59:59.999+08:00'), hkd('2026-09-01'))
  } finally { console.warn = origWarn }
  check('#4 分母=0 → ratio 1', ratio4 === 1, `got ${ratio4}`)
  check('#4 有 warn', warnSpy.some(w => w.includes('分母') && w.includes('0')), `warns: ${JSON.stringify(warnSpy)}`)

  // ═══ #1 #2 A1 8 月：全月在職一分唔變 + 唔查更表 ═══════════════════
  console.log('── #1 #2 A1 8 月（全月在職）──')
  const origShiftFindMany = (prisma.shift as any).findMany.bind(prisma.shift)
  let rosterShiftQueries = 0
  ;(prisma.shift as any).findMany = async (args: any) => {
    if (args && args.select && Object.keys(args.select).length === 1 && 'date' in args.select && !args.include) rosterShiftQueries++ // buildRosterDays 形狀
    return origShiftFindMany(args)
  }
  try {
    const rA1 = await engineDirect(eA1.id, '2026-08', CL_A, CFG_M)
    check('#1 在職全月 8 月 basePay = $17,500', near(rA1.basePay, 17500), `basePay=${rA1.basePay}`)
    check('#2 完整月份唔查更表（buildRosterDays 0 次）', rosterShiftQueries === 0, `roster shift queries=${rosterShiftQueries}`)
  } finally {
    ;(prisma.shift as any).findMany = origShiftFindMany
  }

  // ═══ #23 C 9 月：完整月份 22 更 → 17,500 ═════════════════════════
  console.log('── #23 C 9 月（完整月份 22 更）──')
  const rC = await engineDirect(eC.id, month, CL_B, CFG_M)
  check('#23 完整月份 basePay = $17,500', near(rC.basePay, 17500), `basePay=${rC.basePay}`)

  // ═══ #24 J 月中入職 9/10 + 2 更 → 2/22 ═══════════════════════════
  console.log('── #24 J 月中入職 ──')
  const rJ = await engineDirect(eJ.id, month, CL_B, CFG_M)
  const rdJ = rJ.detail?.employedRatioDetail
  check('#24 J ratio numerator=2 / denominator=22', rdJ?.numerator === 2 && rdJ?.denominator === 22, `rd=${JSON.stringify(rdJ)}`)
  check('#24 J basePay = $1,590.91', near(rJ.basePay, r2(17500 * 2 / 22)), `basePay=${rJ.basePay}`)

  // ═══ #3 E24：24 更 / 22 → min 封頂 1 ═════════════════════════════
  console.log('── #3 E24 24 更（override 9/24）──')
  const r24 = await engineDirect(e24.id, month, CL_B, CFG_M, '2026-09-24')
  const rd24 = r24.detail?.employedRatioDetail
  check('#3 24 更 / 分母 22 → ratio=1', near(r24.basePay, 17500), `basePay=${r24.basePay}`)
  check('#3 detail ratio value=1', near(rd24?.value ?? 0, 1), `rd=${JSON.stringify(rd24)}`)

  // ═══ #10-14 分子組成 ═════════════════════════════════════════════
  console.log('── #10-14 分子組成（override 9/11）──')
  const NUM = 17500
  const cases: Array<[string, any, string, number]> = [
    ['#10 已批帶薪年假計入分子', e10, '2/22', 2],
    ['#11 REST_DAY 假唔計入分子', e11, '1/22', 1],
    ['#12 無薪假唔計入分子', e12, '1/22', 1],
    ['#13 CANCELLED 更唔計入分子', e13, '1/22', 1],
    ['#14 同日雙更 = 1 日', e14, '1/22', 1],
  ]
  for (const [name, emp, expect, expectNum] of cases) {
    const r = await engineDirect(emp.id, month, CL_B, CFG_M, S_LAST_DAY)
    const rd = r.detail?.employedRatioDetail
    check(name, rd?.numerator === expectNum && rd?.denominator === 22, `rd=${JSON.stringify(rd)} (expect ${expect})`)
    check(`${name} basePay`, near(r.basePay, r2(NUM * expectNum / 22)), `basePay=${r.basePay} expect=${r2(NUM * expectNum / 22)}`)
  }

  // ═══ #15 P：打卡日唔入分子（無更 → 0）════════════════════════════
  console.log('── #15 P 只打卡無更（override 9/11）──')
  const rP = await engineDirect(eP.id, month, CL_B, CFG_M, S_LAST_DAY)
  const rdP = rP.detail?.employedRatioDetail
  check('#15 打卡日唔入分子（numerator=0）', rdP?.numerator === 0 && rdP?.denominator === 22, `rd=${JSON.stringify(rdP)}`)
  check('#15 basePay = $0', near(rP.basePay, 0), `basePay=${rP.basePay}`)

  // ═══ #25 H 時薪唔經 ratio ════════════════════════════════════════
  console.log('── #25 H 時薪 8h ──')
  const rH = await engineDirect(eH.id, month, CL_B, CFG_H)
  check('#25 時薪 basePay = $700（8h − 1h 飯鐘 × $100，全日模板 deductLunch=true）', near(rH.basePay, 700), `basePay=${rH.basePay}`)
  check('#25 時薪 detail 無 employedRatioDetail', rH.detail?.employedRatioDetail == null, `rd=${JSON.stringify(rH.detail?.employedRatioDetail)}`)

  // ═══ #5-9 Selina 預覽（resign 前，source ②）══════════════════════
  console.log('── #5-9 Selina resign-preview（resign 前）──')
  {
    const res = await resignPreviewGet(mkReq(`/api/employees/${eS.id}/resign-preview?lastDay=${S_LAST_DAY}`), { params: Promise.resolve({ id: eS.id }) })
    const body = await res.json() as any
    const st = body.settlement
    if (!st) {
      check('#5-9 預覽失敗', false, `status=${res.status} body=${JSON.stringify(body).slice(0, 300)}`)
    } else {
      check('#5 當月工資 = $5,568.18（7/22 × 17,500）', st.monthWage?.basePay != null && near(st.monthWage.basePay, 5568.18), `monthWage=${JSON.stringify(st.monthWage)}`)
      if (typeof st.monthWage?.basePay === 'number') selinaPreviewBasePay = st.monthWage.basePay
      check('#5 source = preview（run 未生成 → 引擎直算）', st.monthWage?.source === 'preview', `source=${st.monthWage?.source}`)
      check('#6 分子 = 7', st.monthWageRatio?.numerator === 7, `ratio=${JSON.stringify(st.monthWageRatio)}`)
      check('#7 分母 = 22', st.monthWageRatio?.denominator === 22, `ratio=${JSON.stringify(st.monthWageRatio)}`)
      check('#8 finalPeriodWage = prorate 當月工資 + leavePayout（唔係全月薪）',
        st.timebank?.caps?.finalPeriodWage != null && near(st.timebank.caps.finalPeriodWage, r2(5568.18 + (st.unusedLeave?.payout ?? 0))),
        `finalPeriodWage=${st.timebank?.caps?.finalPeriodWage} leavePayout=${st.unusedLeave?.payout}`)
      check('#9 1/4 上限基數用 $5,568.18（prorate，唔係全月薪 $17,500）',
        st.timebank?.caps?.quarter != null && near(st.timebank.caps.quarter, r2(st.timebank.caps.finalPeriodWage / 4))
          && st.timebank.caps.finalPeriodWage < r2(17500 + (st.unusedLeave?.payout ?? 0)),
        `quarterCap=${st.timebank?.caps?.quarter} finalPeriodWage=${st.timebank?.caps?.finalPeriodWage} payout=${st.unusedLeave?.payout}`)
      check('#6b detail ratio value = 7/22', st.monthWageRatio?.value != null && near(st.monthWageRatio.value, 7 / 22, 0.001), `value=${st.monthWageRatio?.value}`)
    }
  }

  // ═══ #16-19 payroll-preview override ═════════════════════════════
  console.log('── #16-19 payroll-preview ──')
  {
    const resOv = await payrollPreviewPost(mkReq('/api/payroll-runs/preview', { method: 'POST', body: { periodMonth: month, employeeId: eS.id, resignedAtOverride: S_LAST_DAY } }))
    const bodyOv = await resOv.json() as any
    const itemOv = bodyOv.items?.find((i: any) => i.employeeId === eS.id)
    check('#16 payroll preview + override → basePay $5,568.18', resOv.status === 200 && near(itemOv?.basePay ?? -1, 5568.18), `status=${resOv.status} basePay=${itemOv?.basePay} err=${itemOv?.error}`)

    const resFull = await payrollPreviewPost(mkReq('/api/payroll-runs/preview', { method: 'POST', body: { periodMonth: month, employeeId: eS.id } }))
    const bodyFull = await resFull.json() as any
    const itemFull = bodyFull.items?.find((i: any) => i.employeeId === eS.id)
    check('#17 payroll preview 無 override → basePay $17,500（在職全月）', resFull.status === 200 && near(itemFull?.basePay ?? -1, 17500), `status=${resFull.status} basePay=${itemFull?.basePay}`)

    check('#19 payroll-preview(override) = resign-preview（無一日差）', selinaPreviewBasePay != null && near(itemOv?.basePay ?? -1, selinaPreviewBasePay), `pv=${selinaPreviewBasePay} pp=${itemOv?.basePay}`)
  }

  // ═══ resign S / S2 / S3 ══════════════════════════════════════════
  console.log('── resign S(9/11) S2(today) S3(9/3) ──')
  {
    const rs = await resignPost(mkReq(`/api/employees/${eS.id}/resign`, { method: 'POST', body: { lastDay: S_LAST_DAY } }), { params: Promise.resolve({ id: eS.id }) })
    check('resign S ok', rs.status === 200, `status=${rs.status} body=${JSON.stringify(await rs.clone().json()).slice(0, 200)}`)
    const sAfter = await prisma.employee.findUnique({ where: { id: eS.id } })
    check('S resignedAt = 9/12 HK 午夜', sAfter?.resignedAt?.getTime() === cutoffOf(S_LAST_DAY).getTime(), `resignedAt=${sAfter?.resignedAt}`)
  }
  {
    const rs = await resignPost(mkReq(`/api/employees/${eS2.id}/resign`, { method: 'POST', body: { lastDay: today } }), { params: Promise.resolve({ id: eS2.id }) })
    check('resign S2 ok', rs.status === 200, `status=${rs.status} body=${JSON.stringify(await rs.clone().json()).slice(0, 200)}`)
  }
  {
    const rs = await resignPost(mkReq(`/api/employees/${eS3.id}/resign`, { method: 'POST', body: { lastDay: '2026-09-03' } }), { params: Promise.resolve({ id: eS3.id }) })
    check('resign S3 ok', rs.status === 200, `status=${rs.status} body=${JSON.stringify(await rs.clone().json()).slice(0, 200)}`)
  }

  // ═══ #18 override 遲過實際離職 → 400 ═════════════════════════════
  console.log('── #18 override 收窄 guard ──')
  {
    const res = await payrollPreviewPost(mkReq('/api/payroll-runs/preview', { method: 'POST', body: { periodMonth: month, employeeId: eS.id, resignedAtOverride: '2026-09-15' } }))
    check('#18 override(9/15) 遲過實際離職(9/11) → 400', res.status === 400, `status=${res.status}`)
  }

  // ═══ 生成全店 9 月計糧單（resign 之後）════════════════════════════
  console.log('── generate whole-store run 2026-09 ──')
  let runId1 = ''
  {
    const run = await generatePayrollRun(null, month) as { runId: string; itemCount: number }
    runId1 = run.runId
    runIds.push(runId1)
    check('run 生成成功', !!runId1 && run.itemCount > 0, `itemCount=${run.itemCount}`)
    const itS = await prisma.payrollItem.findFirst({ where: { runId: runId1, employeeId: eS.id } })
    const dS = itS?.detailJson ? JSON.parse(itS.detailJson) : null
    check('#5b run S basePay = $5,568.18', near(itS?.basePay ?? -1, 5568.18), `basePay=${itS?.basePay}`)
    check('#6c run S detailJson.employedRatioDetail = {7, 22}', dS?.employedRatioDetail?.numerator === 7 && dS?.employedRatioDetail?.denominator === 22, `rd=${JSON.stringify(dS?.employedRatioDetail)}`)
    const itS2 = await prisma.payrollItem.findFirst({ where: { runId: runId1, employeeId: eS2.id } })
    check('#20b run S2 basePay = $2,386.36（3/22）', near(itS2?.basePay ?? -1, r2(17500 * 3 / 22)), `basePay=${itS2?.basePay}`)
  }

  // ═══ Selina 預覽再行一次 → source ①（run 權威）════════════════════
  {
    const res = await resignPreviewGet(mkReq(`/api/employees/${eS.id}/resign-preview?lastDay=${S_LAST_DAY}`), { params: Promise.resolve({ id: eS.id }) })
    const body = await res.json() as any
    check('#5c resign 後預覽 source=payrollItem 同值 $5,568.18', body.settlement?.monthWage?.source === 'payrollItem' && near(body.settlement?.monthWage?.basePay ?? -1, 5568.18), `mw=${JSON.stringify(body.settlement?.monthWage)}`)
  }

  // ═══ #20 #22 S2 結算（notice 7 日 + TB −540）═════════════════════
  console.log('── S2 resign-settle ──')
  {
    const res = await resignSettlePost(mkReq(`/api/employees/${eS2.id}/resign-settle`, { method: 'POST', body: { lastDay: today, noticeDays: 7, tbDeduction: 575.34 } }), { params: Promise.resolve({ id: eS2.id }) })
    const body = await res.json() as any
    check('settle S2 ok', res.status === 200, `status=${res.status} body=${JSON.stringify(body).slice(0, 300)}`)
    const itS2 = await prisma.payrollItem.findFirst({ where: { runId: runId1, employeeId: eS2.id } })
    const snap = itS2?.resignSettlementJson ? JSON.parse(itS2.resignSettlementJson) : null
    check('#20 snapshot monthWageRatio = {3, 22, lastDay=today}',
      snap?.monthWageRatio?.numerator === 3 && snap?.monthWageRatio?.denominator === 22 && snap?.monthWageRatio?.lastDay === today,
      `snap=${JSON.stringify(snap?.monthWageRatio)}`)
    check('#20b snapshot 有 value + computedAt', typeof snap?.monthWageRatio?.value === 'number' && !!snap?.monthWageRatio?.computedAt, `snap=${JSON.stringify(snap?.monthWageRatio)}`)
    check('#20c snapshot monthWage.basePay = $2,386.36（run 讀唔算）', near(snap?.monthWage?.basePay ?? -1, r2(17500 * 3 / 22)), `mw=${JSON.stringify(snap?.monthWage)}`)

    // #22 重算 run → 注入 snapshot 金額（證明讀快照唔重算）
    const run2 = (await generatePayrollRun(null, month)) as { runId: string; itemCount: number }
    const runId2 = run2.runId
    runIds.push(runId2)
    const itS2b = await prisma.payrollItem.findFirst({ where: { runId: runId2, employeeId: eS2.id } })
    const snap2 = await prisma.payrollItem.findFirst({ where: { runId: runId1, employeeId: eS2.id }, select: { resignSettlementJson: true } })
    const snap2j = snap2?.resignSettlementJson ? JSON.parse(snap2.resignSettlementJson) : null
    // ADW 真路徑：S2 有 9 月 run item（eoWage 2386.36 / 30 日）→ ADW 79.55 → notice 7 日 = 556.85
    // totalPayable = basePay + noticePay − tbDed（全部由 snapshot 注入）
    const baseS2 = r2(17500 * 3 / 22)
    const expectNotice = r2(r2(baseS2 / 30) * 7)
    const expectTotal = r2(baseS2 + (snap2j?.noticePay ?? 0) - (snap2j?.tbDeduction ?? 0))
    check('#22a snapshot noticePay = 7 × ADW(79.55) = 556.85（ADW 真路徑讀 run item）', near(snap2j?.noticePay ?? -1, expectNotice), `noticePay=${snap2j?.noticePay} expect=${expectNotice} adwUsed=${snap2j?.adwUsed}`)
    check('#22b snapshot tbDeduction = 575.34', snap2j?.tbDeduction === 575.34, `tbDed=${snap2j?.tbDeduction}`)
    check('#22c 重算 run 讀 snapshot 注入（totalPayable = base + notice − tbDed）', near(itS2b?.totalPayable ?? -1, expectTotal), `totalPayable=${itS2b?.totalPayable} expect=${expectTotal}`)
    check('#22d 無注入時應為 basePay（snap 注入有效 → totalPayable ≠ basePay）', itS2b?.totalPayable != null && !near(itS2b.totalPayable, baseS2), `totalPayable=${itS2b?.totalPayable} base=${baseS2}`)
    void runId2
  }

  // ═══ #21 S3：結算 9/3 → 重結算 9/2 → snapshot 覆蓋 + audit ═══════
  console.log('── S3 resign-settle 9/3 → 9/2 ──')
  {
    const r1 = await resignSettlePost(mkReq(`/api/employees/${eS3.id}/resign-settle`, { method: 'POST', body: { lastDay: '2026-09-03', noticeDays: 0, tbDeduction: 0 } }), { params: Promise.resolve({ id: eS3.id }) })
    check('settle S3 (9/3) ok', r1.status === 200, `status=${r1.status} body=${JSON.stringify(await r1.clone().json()).slice(0, 300)}`)
    let it = await prisma.payrollItem.findFirst({ where: { runId: runId1, employeeId: eS3.id } })
    let snap = it?.resignSettlementJson ? JSON.parse(it.resignSettlementJson) : null
    check('#21a 首結 lastDay=9/3 numerator=3', snap?.monthWageRatio?.lastDay === '2026-09-03' && snap?.monthWageRatio?.numerator === 3, `snap=${JSON.stringify(snap?.monthWageRatio)}`)

    const r2x = await resignSettlePost(mkReq(`/api/employees/${eS3.id}/resign-settle`, { method: 'POST', body: { lastDay: '2026-09-02', noticeDays: 0, tbDeduction: 0 } }), { params: Promise.resolve({ id: eS3.id }) })
    check('re-settle S3 (9/2) ok', r2x.status === 200, `status=${r2x.status} body=${JSON.stringify(await r2x.clone().json()).slice(0, 300)}`)
    it = await prisma.payrollItem.findFirst({ where: { runId: runId1, employeeId: eS3.id } })
    snap = it?.resignSettlementJson ? JSON.parse(it.resignSettlementJson) : null
    check('#21b 重結 lastDay 覆蓋為 9/2 且 numerator 重算 = 2', snap?.monthWageRatio?.lastDay === '2026-09-02' && snap?.monthWageRatio?.numerator === 2, `snap=${JSON.stringify(snap?.monthWageRatio)}`)
    const audits = await prisma.auditLog.findMany({ where: { targetEmployeeId: eS3.id }, orderBy: { createdAt: 'desc' }, take: 10 })
    const noteHit = audits.some(a => a.action === 'EMPLOYEE_RESIGN_SETTLE' && (a.notes ?? '').includes('最後工作日由 2026-09-03 改為 2026-09-02，ratio 重算'))
    check('#21c audit 記錄「最後工作日由 9/3 改為 9/2，ratio 重算」', noteHit, `audits=${JSON.stringify(audits.map(a => ({ a: a.action, n: (a.notes ?? '').slice(0, 160) }))).slice(0, 500)}`)
  }

  // ── summary ─────────────────────────────────────────────────────
  console.log(`\n═══ RESULT: PASS=${pass} FAIL=${fail} ═══`)
  if (fails.length) {
    console.log('失敗項：')
    for (const f of fails) console.log(`  ✖ ${f}`)
  }

  // ── sweep ───────────────────────────────────────────────────────
  console.log('── sweep（e2erg 前綴 → 0 殘留）──')
  await sweep()
  const leftoverEmp = await prisma.employee.count({ where: { id: { startsWith: 'e2ergr' } } })
  const leftoverUser = await prisma.user.count({ where: { id: { startsWith: 'e2ergr' } } })
  const leftoverShift = await prisma.shift.count({ where: { employee: { id: { startsWith: 'e2ergr' } } } })
  const leftoverRun = await prisma.payrollRun.count({ where: { id: { in: runIds } } })
  const leftoverPunch = await prisma.punchRecord.count({ where: { employee: { id: { startsWith: 'e2ergr' } } } })
  const leftoverLeave = await prisma.leaveRequest.count({ where: { employee: { id: { startsWith: 'e2ergr' } } } })
  const leftoverTB = await prisma.timeBank.count({ where: { employeeId: { in: ids } } })
  const leftoverTBE = await prisma.timeBankEntry.count({ where: { employeeId: { in: ids } } })
  const leftoverItem = await prisma.payrollItem.count({ where: { runId: { in: runIds } } })
  const auditKept = await prisma.auditLog.count({ where: { targetEmployeeId: { in: ids } } })
  console.log(`  殘留: emp=${leftoverEmp} user=${leftoverUser} shift=${leftoverShift} punch=${leftoverPunch} leave=${leftoverLeave} tb=${leftoverTB} tbe=${leftoverTBE} run=${leftoverRun} item=${leftoverItem}（auditLog 保留=${auditKept}）`)
  const clean = leftoverEmp === 0 && leftoverUser === 0 && leftoverShift === 0 && leftoverPunch === 0 && leftoverLeave === 0 && leftoverTB === 0 && leftoverTBE === 0 && leftoverRun === 0 && leftoverItem === 0
  check('sweep 0 殘留（append-only AuditLog 除外）', clean, `emp=${leftoverEmp} user=${leftoverUser} shift=${leftoverShift} punch=${leftoverPunch} leave=${leftoverLeave} tb=${leftoverTB} tbe=${leftoverTBE} run=${leftoverRun} item=${leftoverItem}`)

  await prisma.$disconnect()
  process.exit(fail === 0 ? 0 : 1)
}

main()
  .catch(async (e) => {
    console.error('FATAL', e)
    try { await sweep(); console.log('（sweep 已執行）') } catch { /* ignore */ }
    await prisma.$disconnect()
    process.exit(2)
  })

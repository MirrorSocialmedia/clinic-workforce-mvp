/**
 * cwm-caldayratio-20260906 — T5 生死格 deep-equal 共用 fixture（跟 mpf60 模式）
 *
 * BEFORE：改 engine 前（d1e23683 roster 版）跑 → /tmp/emp-caldayratio-before.json
 * AFTER ：改完 e2e 重建同值 fixture → deep-equal 全欄 → 在職員工一分唔變
 *
 * fixture 全 deterministic（固定日期/固定更表）— 兩邊各建各冧，值一樣。
 * 前綴 e2calb + 秒戳（後 6 位），做完 sweep 0 殘留。
 * REAL_IDS = DB 內 4 個真實在職長役員工（唔 sweep — 佢哋係 seed 唔係 fixture）。
 */
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { calculatePayrollWithRules } from '../src/lib/payroll-engine'
import { hkDayOfWeek } from '../src/lib/hk-date'

export const P = 'e2calb'
export const PFX = `${P}${String(Math.floor(Date.now() / 1000)).slice(-6)}`
const MONTH = '2026-09'

/** 真實在職長役員工（生死格 #1）— 全部 2020–2023 年入職、resignedAt NULL、9 月全月在職 */
export const REAL_IDS = [
  'cmtn52you000i3e5oxfjjt2o9', // 陳醫生 SPLIT 8000
  'cmtn52yow000m3e5o0ezw9c18', // 李經理 MONTHLY 20000
  'cmtn52yoy000v3e5oa94w34f8', // 張會計 MONTHLY 18000
  'cmtn52yoz000z3e5o2jc0hpp8', // 王護士 MONTHLY 15000
]

type CohortSpec = { key: string; join: string; salary: number; leave: null | { sick: string[]; unpaid: string[] } }
// 全部在職（resignedAt NULL）長役全月 — 新 code 必須一分唔變（return 1 短路）。
// R4 加病假×2＋無薪假×1 → 覆蓋 #22 扣薪日率（÷22 workday 口徑）回归。
export const COHORT: CohortSpec[] = [
  { key: 'R1', join: '2025-01-01', salary: 18000, leave: null },
  { key: 'R2', join: '2024-03-15', salary: 40000, leave: null },
  { key: 'R3', join: '2025-06-30', salary: 7100, leave: null },
  { key: 'R4', join: '2025-01-01', salary: 12000, leave: { sick: ['2026-09-08', '2026-09-09'], unpaid: ['2026-09-14'] } },
]

export const CFG = (salary: number): any => ({
  base_type: 'monthly',
  monthly_salary: salary,
  modifiers: {
    working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
    mpf: { enabled: true, rate: 0.05, min: 7100, max: 30000 },
  },
})

const hk = (d: string) => new Date(`${d}T00:00:00+08:00`)
const at = (d: string, h: number) => new Date(`${d}T${String(h).padStart(2, '0')}:00:00+08:00`)

/** 2026-09 頭 22 個 weekday（9/1=二；9/8、9/9、9/14 係 R4 假日 → 唔排更） */
export function septWeekdays(): string[] {
  const out: string[] = []
  let cur = '2026-09-01'
  while (out.length < 22 && cur <= '2026-09-30') {
    if (![0, 6].includes(hkDayOfWeek(cur))) out.push(cur)
    const [y, m, d] = cur.split('-').map(Number)
    cur = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
  }
  return out
}

export async function buildCohort(): Promise<Record<string, string>> {
  const prisma = new PrismaClient()
  try {
    const clinic = await prisma.clinic.findFirst({ orderBy: { id: 'asc' } })
    const owner = await prisma.user.findFirst({ where: { role: 'OWNER' }, orderBy: { id: 'asc' } })
    const tmp = await prisma.shiftTemplate.findFirst({ where: { name: '全日' } })
    const ltSick = await prisma.leaveType.findFirst({ where: { systemKey: 'SICK' } })
    const ltUnpaid = await prisma.leaveType.findFirst({ where: { isPaid: false, name: '無薪假' } })
    if (!clinic || !owner || !tmp || !ltSick || !ltUnpaid) throw new Error('seed missing (clinic/owner/全日/SICK/無薪假)')

    await sweepCohort(PFX) // pre-clean（冪等）
    const days = septWeekdays()
    const ids: Record<string, string> = {}
    for (const s of COHORT) {
      const leaveDays = new Set(s.leave ? [...s.leave.sick, ...s.leave.unpaid] : [])
      const user = await prisma.user.create({
        data: { id: `${PFX}u${s.key}0000000000000001`.slice(0, 25), name: `${PFX}${s.key}`, phone: `62${s.key}${PFX.slice(-4)}`, email: `${PFX}_${s.key}@test.invalid`, role: 'EMPLOYEE', status: 'ACTIVE', password: 'x'.repeat(60) },
      })
      const emp = await prisma.employee.create({
        data: { id: `${PFX}e${s.key}0000000000000001`.slice(0, 25), userId: user.id, joinDate: hk(s.join), status: 'ACTIVE', homeClinicId: clinic.id },
      })
      ids[s.key] = emp.id
      await prisma.employeeClinic.create({ data: { employeeId: emp.id, clinicId: clinic.id, isPrimary: true } })
      await prisma.payRule.create({
        data: { employeeId: emp.id, payType: 'MONTHLY', baseAmount: s.salary, configJson: JSON.stringify(CFG(s.salary)), effectiveFrom: hk('2020-01-01'), isActive: true, createdBy: owner.id },
      })
      for (const d of days) {
        if (leaveDays.has(d)) continue // 假日唔排更
        await prisma.shift.create({ data: { employeeId: emp.id, clinicId: clinic.id, templateId: tmp.id, date: hk(d), startTime: at(d, 9), endTime: at(d, 18), status: 'CONFIRMED', createdBy: owner.id } })
        await prisma.punchRecord.create({ data: { employeeId: emp.id, clinicId: clinic.id, punchTime: at(d, 9), punchType: 'CLOCK_IN', source: 'SYSTEM' } })
        await prisma.punchRecord.create({ data: { employeeId: emp.id, clinicId: clinic.id, punchTime: at(d, 18), punchType: 'CLOCK_OUT', source: 'SYSTEM' } })
      }
      if (s.leave) {
        for (const d of s.leave.sick) {
          await prisma.leaveRequest.create({ data: { employeeId: emp.id, leaveTypeId: ltSick.id, startDate: hk(d), endDate: hk(d), days: 1, status: 'APPROVED', approverId: owner.id, approvedAt: hk('2026-09-07') } })
        }
        for (const d of s.leave.unpaid) {
          await prisma.leaveRequest.create({ data: { employeeId: emp.id, leaveTypeId: ltUnpaid.id, startDate: hk(d), endDate: hk(d), days: 1, status: 'APPROVED', approverId: owner.id, approvedAt: hk('2026-09-07') } })
        }
      }
    }
    return ids
  } finally {
    await prisma.$disconnect()
  }
}

/** 全欄 capture（normalise：strip id 類欄，留計算欄）— cohort + REAL 一齊 */
export async function captureCohort(ids: Record<string, string>): Promise<Record<string, any>> {
  const prisma = new PrismaClient()
  const monthDate = new Date('2026-09-01T00:00:00+08:00')
  const out: Record<string, any> = {}
  try {
    const clinic = (await prisma.clinic.findFirst({ orderBy: { id: 'asc' } }))!
    for (const s of COHORT) {
      const r = await calculatePayrollWithRules(ids[s.key], monthDate, clinic.id, CFG(s.salary))
      if (r.error) throw new Error(`${s.key} engine error: ${r.error}`)
      out[s.key] = JSON.parse(JSON.stringify(r, stripIds))
    }
    // 真實在職員工：用佢哋 DB 落住嘅 PayRule configJson（同 generatePayrollRun 同源口徑）
    for (const rid of REAL_IDS) {
      const rule = await prisma.payRule.findFirst({ where: { employeeId: rid, isActive: true } })
      if (!rule) { out[`REAL_${rid}`] = { skipped: 'no payrule' }; continue }
      const r = await calculatePayrollWithRules(rid, monthDate, clinic.id, JSON.parse(rule.configJson ?? '{}'))
      out[`REAL_${rid}`] = r.error ? { error: r.error } : JSON.parse(JSON.stringify(r, stripIds))
    }
    return out
  } finally {
    await prisma.$disconnect()
  }
}

function stripIds(_k: string, v: any): any {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o: any = {}
    for (const [k, val] of Object.entries(v)) {
      if (/^id$|Id$/.test(k) && typeof val === 'string' && val.length > 0 && !/^\d/.test(val)) continue // 跳過 cuid 欄
      o[k] = stripIds(k, val)
    }
    return o
  }
  if (Array.isArray(v)) return v.map(x => stripIds(_k, x))
  return v
}

/** FK 序 sweep（PunchRecord/AuditLog append-only trigger dance）— 只洗 e2calb 前綴 */
export async function sweepCohort(prefix: string) {
  const prisma = new PrismaClient()
  try {
    const emps = await prisma.employee.findMany({ where: { id: { startsWith: prefix } }, select: { id: true, userId: true } })
    const empIds = emps.map(e => e.id)
    const userIds = [...new Set(emps.map(e => e.userId))]
    if (empIds.length === 0) return
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
  } finally {
    await prisma.$disconnect()
  }
}

/** BEFORE 捕快（改 engine 前跑）：build → capture → sweep → 寫檔 */
export async function runBeforeCapture(outPath: string) {
  const ids = await buildCohort()
  const cap = await captureCohort(ids)
  await sweepCohort(PFX)
  fs.writeFileSync(outPath, JSON.stringify({ pfx: PFX, month: MONTH, capturedAt: new Date().toISOString(), results: cap }, null, 2))
  console.log(`BEFORE capture 完成 → ${outPath}（${Object.keys(cap).length} 員工，fixture 已 sweep）`)
  for (const [k, v] of Object.entries(cap)) {
    const d = v as any
    console.log(`  ${k}: basePay=${d.basePay} grossPay=${d.detail?.grossPay} mpf=${d.detail?.mpf} netPay=${d.detail?.netPay} sick=${d.detail?.sickDeduction} ratio=${d.detail?.employedRatioDetail ? JSON.stringify(d.detail.employedRatioDetail) : 'n/a'}`)
  }
}

if (require.main === module) {
  runBeforeCapture('/tmp/emp-caldayratio-before.json').then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
}

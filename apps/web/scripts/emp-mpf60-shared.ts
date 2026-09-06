/**
 * cwm-mpf60-20260906 — #19 生死格共用 fixture（在職長役員工 cohort）
 *
 * 用途：動 engine 前 capture（emp-mpf60-before.ts）→ /tmp/emp-mpf60-before.json
 *      動 engine 後 e2e 重建同值 fixture → deep-equal 全欄（resigpay 回歸模式）。
 *
 * fixture 全 deterministic（固定日期/固定更表）— 兩邊各建各冧，值一樣。
 * 前綴 e2em60b，做完 sweep。
 */
import fs from 'node:fs'
import { PrismaClient } from '@prisma/client'
import { calculatePayrollWithRules } from '../src/lib/payroll-engine'
import { hkDayOfWeek } from '../src/lib/hk-date'

export const PRISM_A = new PrismaClient()
const P = 'e2em60b'
export const PFX = `${P}${String(Math.floor(Date.now() / 1000)).slice(-6)}` // 每輪新 id，sweep 按前缀

const MONTH = '2026-09'

type CohortSpec = { key: string; join: string; salary: number }
// 在職（resignedAt NULL）、長役（遠超 60 日 + 免供款期）— 新 code 必須一分唔變。
// OT 重算路徑唔喺呢度覆（PunchRecord append-only 唔好刪改）— 由 #9（離職 OT 場景兩 caller 一致）負責。
export const COHORT: CohortSpec[] = [
  { key: 'R1', join: '2025-01-01', salary: 18000 },
  { key: 'R2', join: '2024-03-15', salary: 40000 },
  { key: 'R3', join: '2025-06-30', salary: 7100 },
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

export function septWeekdays(from: string, to: string): string[] {
  const out: string[] = []
  let cur = from
  while (cur <= to) {
    if (![0, 6].includes(hkDayOfWeek(cur))) out.push(cur)
    const [y, m, d] = cur.split('-').map(Number)
    cur = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
  }
  return out
}

export async function buildCohort(): Promise<Record<string, string>> {
  const prisma = PRISM_A
  const clinic = await prisma.clinic.findFirst({ orderBy: { id: 'asc' } })
  const owner = await prisma.user.findFirst({ where: { role: 'OWNER' }, orderBy: { id: 'asc' } })
  if (!clinic || !owner) throw new Error('seed missing (clinic/owner)')

  // pre-clean（冪等）
  await sweepCohort(PFX)

  const ids: Record<string, string> = {}
  for (const s of COHORT) {
    const user = await prisma.user.create({
      data: { id: `${PFX}u${s.key}0000000000000001`.slice(0, 25), name: `${PFX}${s.key}`, phone: `61${s.key}${PFX.slice(-4)}`, email: `${PFX}_${s.key}@test.invalid`, role: 'EMPLOYEE', status: 'ACTIVE', password: 'x'.repeat(60) },
    })
    const emp = await prisma.employee.create({
      data: { id: `${PFX}e${s.key}0000000000000001`.slice(0, 25), userId: user.id, joinDate: hk(s.join), status: 'ACTIVE', homeClinicId: clinic.id },
    })
    ids[s.key] = emp.id
    await prisma.employeeClinic.create({ data: { employeeId: emp.id, clinicId: clinic.id, isPrimary: true } })
    await prisma.payRule.create({
      data: { employeeId: emp.id, payType: 'MONTHLY', baseAmount: s.salary, configJson: JSON.stringify(CFG(s.salary)), effectiveFrom: hk('2020-01-01'), isActive: true, createdBy: owner.id },
    })
    const days = septWeekdays('2026-09-01', '2026-09-30').slice(0, 22)
    for (const d of days) {
      await prisma.shift.create({ data: { employeeId: emp.id, clinicId: clinic.id, date: hk(d), startTime: at(d, 9), endTime: at(d, 18), status: 'CONFIRMED', createdBy: owner.id } })
      await prisma.punchRecord.create({ data: { employeeId: emp.id, clinicId: clinic.id, punchTime: at(d, 9), punchType: 'CLOCK_IN', source: 'SYSTEM' } })
      await prisma.punchRecord.create({ data: { employeeId: emp.id, clinicId: clinic.id, punchTime: at(d, 18), punchType: 'CLOCK_OUT', source: 'SYSTEM' } })
    }
  }
  return ids
}

/** 全欄 capture（normalise：strip 掉 id 類欄先，留計算欄） */
export async function captureCohort(ids: Record<string, string>): Promise<Record<string, any>> {
  const prisma = PRISM_A
  const clinic = await prisma.clinic.findFirst({ orderBy: { id: 'asc' } })
  const monthDate = new Date('2026-09-01T00:00:00+08:00')
  const out: Record<string, any> = {}
  for (const s of COHORT) {
    const r = await calculatePayrollWithRules(ids[s.key], monthDate, clinic!.id, CFG(s.salary))
    if (r.error) throw new Error(`${s.key} engine error: ${r.error}`)
    out[s.key] = JSON.parse(JSON.stringify(r, stripIds))
  }
  return out
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

export async function sweepCohort(prefix: string) {
  const prisma = PRISM_A
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
}

/** 供 emp-mpf60-before.ts 用：一氣 build → capture → sweep → 寫檔 */
export async function runCapture(outPath: string) {
  const ids = await buildCohort()
  const cap = await captureCohort(ids)
  await sweepCohort(PFX)
  fs.writeFileSync(outPath, JSON.stringify({ pfx: PFX, month: MONTH, capturedAt: new Date().toISOString(), results: cap }, null, 2))
  console.log(`capture 完成 → ${outPath}（${Object.keys(cap).length} 員工，已 sweep）`)
  return cap
}

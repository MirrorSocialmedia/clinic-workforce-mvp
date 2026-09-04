/**
 * cwm-resigpay-20260904 T1 — 完整月份回歸腳本（生死格 #1）
 *
 * 用法（兩個階段，DB 重置之間各跑一次）：
 *   DATABASE_URL=... BATCH=t1reg npx tsx scripts/e2e-resigpay-t1reg.ts build   # 建 deterministic fixture
 *   DATABASE_URL=... BATCH=t1reg npx tsx scripts/e2e-resigpay-t1reg.ts run     # 生成 2026-08 + dump 金額
 *
 * 零 PII：employee name = E2ERegFull-<batch>，email @test.invalid。
 * 冪等：build 檢查 email 已存在就 skip。
 */
import { prisma } from '../src/lib/prisma'
import { generatePayrollRun } from '../src/lib/payroll-engine'

const BATCH = process.env.BATCH || 't1reg'
const PERIOD = '2026-08'
const SALARY = 18000

function hk(d: string): Date { return new Date(`${d}T00:00:00+08:00`) }
function at(d: string, h: number, m = 0): Date {
  return new Date(`${d}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`)
}

async function build() {
  const email = `e2eregfull_${BATCH}@test.invalid`
  const existing = await prisma.user.findFirst({ where: { email } })
  if (existing) { console.log('fixture exists — skip (idempotent)'); return }

  const clinic = await prisma.clinic.findFirst({ orderBy: { id: 'asc' } })
  if (!clinic) throw new Error('no clinic — seed first')
  const owner = await prisma.user.findFirst({ where: { role: 'OWNER' }, orderBy: { id: 'asc' } })
  if (!owner) throw new Error('no owner user — seed first')

  const user = await prisma.user.create({
    data: { name: `E2ERegFull-${BATCH}`, email, phone: `9${(BATCH.length * 7).toString().padStart(6, '0')}${BATCH.length}`, role: 'EMPLOYEE', status: 'ACTIVE', password: 'e2e-unused' },
  })
  const emp = await prisma.employee.create({
    data: {
      userId: user.id,
      joinDate: hk('2020-01-01'),
      status: 'ACTIVE',
      homeClinicId: clinic.id,
    },
  })
  await prisma.payRule.create({
    data: {
      employeeId: emp.id,
      payType: 'MONTHLY',
      baseAmount: SALARY,
      configJson: JSON.stringify({
        base_type: 'monthly',
        monthly_salary: SALARY,
        modifiers: {
          working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
          mpf: { enabled: true, rate: 0.05, min: 7100, max: 50000 },
        },
      }),
      effectiveFrom: hk('2020-01-01'),
      isActive: true,
      createdBy: owner.id,
    },
  })

  // 2026-08 應出勤日 = 非休息日(六日) 且 非 DB 公眾假期
  const phs = await prisma.hKPublicHoliday.findMany({
    where: { date: { gte: hk('2026-08-01'), lte: hk('2026-08-31') } },
  })
  const { toHKDateStr } = await import('../src/lib/hk-date')
  const phHK = new Set(phs.map((p: any) => toHKDateStr(new Date(p.date))))

  const daysInMonth = 31
  let shifts = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `2026-08-${String(d).padStart(2, '0')}`
    const dow = new Date(Date.UTC(2026, 7, d)).getUTCDay()
    if (dow === 0 || dow === 6) continue
    if (phHK.has(ds)) continue
    await prisma.shift.create({
      data: {
        employeeId: emp.id,
        clinicId: clinic.id,
        date: hk(ds),
        startTime: at(ds, 9),
        endTime: at(ds, 18),
        status: 'CONFIRMED',
        createdBy: owner.id,
      },
    })
    await prisma.punchRecord.create({
      data: { employeeId: emp.id, clinicId: clinic.id, punchTime: at(ds, 9), punchType: 'CLOCK_IN', source: 'SYSTEM' },
    })
    await prisma.punchRecord.create({
      data: { employeeId: emp.id, clinicId: clinic.id, punchTime: at(ds, 18), punchType: 'CLOCK_OUT', source: 'SYSTEM' },
    })
    shifts++
  }
  console.log(`✅ fixture built: user=${user.id} emp=${emp.id} shifts=${shifts} (batch=${BATCH})`)
}

async function run() {
  const res = await generatePayrollRun(null, PERIOD)
  if ((res as any).error) throw new Error(`generate failed: ${(res as any).error}`)
  const runId = (res as any).runId
  const items = await prisma.payrollItem.findMany({
    where: { runId },
    include: { employee: { include: { user: { select: { name: true } } } } },
  })
  const dump = items.map((it: any) => ({
    name: it.employee.user.name,
    status: it.employee.status,
    basePay: it.basePay,
    otPay: it.otPay,
    deduction: it.deduction,
    totalPayable: it.totalPayable,
    eoWage: it.eoWage,
    absentDays: it.absentDays,
    leaveDays: it.leaveDays,
    workedHours: it.workedHours,
    detail: JSON.parse(it.detailJson || '{}'),
  }))
  const fs = await import('node:fs')
  const out = process.env.OUT || `/tmp/kairo-resigpay-t1reg-${BATCH}.json`
  fs.writeFileSync(out, JSON.stringify({ runId, items: dump }, null, 2))
  console.log(`✅ dumped ${dump.length} items → ${out}`)
  for (const it of dump) console.log(`  ${it.name}: base=${it.basePay} total=${it.totalPayable} ratio=${(it.detail as any).employedRatio}`)
}

async function main() {
  const phase = process.argv[2]
  if (phase === 'build') await build()
  else if (phase === 'run') await run()
  else { console.error('phase: build|run'); process.exit(1) }
}

main()
  .catch((e: any) => { console.error('❌', e.message); process.exit(1) })
  .finally(() => prisma.$disconnect())

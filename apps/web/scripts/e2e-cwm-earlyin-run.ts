import prisma from '@/lib/prisma'
import { generatePayrollRun } from '@/lib/payroll-engine'

const CLINIC = 'e2ekathyclinic20260831001'

async function main() {
  const r = await generatePayrollRun(CLINIC, '2026-08')
  console.log('RUN ' + JSON.stringify(r))
  if ('runId' in r && r.runId) {
    const run = await prisma.payrollRun.findUnique({ where: { id: r.runId }, select: { id: true, status: true, periodMonth: true } })
    const items = await prisma.payrollItem.findMany({ where: { runId: r.runId }, select: { id: true, employeeId: true, workedHours: true, otHours: true, basePay: true, otPay: true, splitPay: true, deduction: true, totalPayable: true } })
    console.log('RUNDETAIL ' + JSON.stringify({ run, items }))
  }
}

main().catch((e) => { console.error('RUN_FAIL', e); process.exit(1) })
  .finally(() => prisma.$disconnect())

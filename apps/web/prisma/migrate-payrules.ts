import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

function toModular(old: any, payType: string, baseAmount: number) {
  // Already new format → skip
  if (old?.base_type || old?.modifiers) return null
  // null / empty object / old format → convert to new format
  return {
    base_type: payType === 'MONTHLY' ? 'monthly'
      : payType === 'HOURLY' ? 'hourly'
      : payType === 'DAILY' ? 'daily' : 'monthly',
    ...(payType === 'MONTHLY' ? { monthly_salary: baseAmount }
      : payType === 'HOURLY' ? { hourly_rate: baseAmount }
      : { daily_rate: baseAmount }),
    modifiers: {
      working_days: { basis: 'scheduled', rest_days: [6, 0], count_public_holidays: true },
      deduction: { basis: 'statutory' },
      mpf: { enabled: true, rate: 0.05, min: 7100, max: 30000 },
    },
  }
}

async function main() {
  const rules = await prisma.payRule.findMany()
  let migrated = 0
  for (const r of rules) {
    const old = r.configJson ? JSON.parse(r.configJson) : {}
    const modular = toModular(old, r.payType, r.baseAmount ?? 0)
    if (modular) {
      await prisma.payRule.update({
        where: { id: r.id },
        data: { configJson: JSON.stringify(modular) },
      })
      migrated++
      console.log(`✅ Migrated rule ${r.id} (employeeId: ${r.employeeId})`)
    } else {
      console.log(`⏭️  Already new format: rule ${r.id}`)
    }
  }
  console.log(`\nDone: ${migrated} rules migrated to new format`)
}

main().catch(console.error).finally(() => prisma.$disconnect())

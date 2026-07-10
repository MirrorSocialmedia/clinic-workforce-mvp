import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

async function main() {
  const emp = await p.employee.findFirst({
    where: { user: { phone: '91000004' } },
    include: { payRules: { where: { isActive: true } } },
  })
  const r = emp?.payRules[0]
  console.log('configJson:', r?.configJson)
  const c = JSON.parse(r?.configJson || '{}')
  console.log('base_type:', c.base_type, '| mpf:', JSON.stringify(c.mpf))
  await p.$disconnect()
}

main()

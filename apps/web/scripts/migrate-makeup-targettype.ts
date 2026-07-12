import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()

async function main() {
  const entries = await p.timeBankEntry.findMany({
    where: { type: 'MAKEUP', targetType: null },
  })
  for (const e of entries) {
    const t = e.note?.includes('早退') ? 'EARLY_LEAVE' : 'LATE'
    await p.timeBankEntry.update({
      where: { id: e.id },
      data: { targetType: t },
    })
  }
  console.log(`已遷移 ${entries.length} 筆 MAKEUP 記錄`)
}

main().catch(console.error).finally(() => p.$disconnect())

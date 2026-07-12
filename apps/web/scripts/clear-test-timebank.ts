import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

async function main() {
  // Clear all TimeBank records (safe for test environment)
  const deleted = await p.timeBank.deleteMany({})
  console.log(`已清除 ${deleted.count} 筆 TimeBank 記錄`)

  // Also clear TimeBankEntry if any
  const entries = await p.timeBankEntry.deleteMany({})
  console.log(`已清除 ${entries.count} 筆 TimeBankEntry 記錄`)
}

main().catch(console.error).finally(() => p.$disconnect())

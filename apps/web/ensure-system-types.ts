/**
 * ═══════════════════════════════════════════════════════════
 *  ensure-system-types.ts — 確保系統假期類型存在（可隨時重跑）
 *
 *  休息日/年假/OT補假 是計算核心（systemKey 鎖死），但只在 seed 建。
 *  若被舊腳本/舊版seed刪掉，跑這個補回，不動任何現有資料。
 *
 *  用法：
 *    DATABASE_URL="postgresql://clinic:devpass@localhost:5432/clinic_test" npx tsx ensure-system-types.ts
 *  （正式庫 clinic_mvp 也可以安全跑——upsert 冪等，不刪不改現有）
 * ═══════════════════════════════════════════════════════════
 */
import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const SYSTEM_TYPES = [
  { systemKey: 'REST_DAY',     name: '休息日',  isPaid: true, color: '#4a4a4a' },
  { systemKey: 'ANNUAL_LEAVE', name: '年假',    isPaid: true, color: '#27ae60', annualQuota: 12 },
  { systemKey: 'OT_LEAVE',     name: 'OT補假',  isPaid: true, color: '#8e44ad' },
]

async function main() {
  console.log('🔒 檢查系統假期類型...\n')
  for (const t of SYSTEM_TYPES) {
    const existing = await prisma.leaveType.findUnique({ where: { systemKey: t.systemKey } })
    if (existing) {
      console.log(`  ✓ ${t.name}（${t.systemKey}）已存在`)
    } else {
      await prisma.leaveType.create({ data: t as any })
      console.log(`  ➕ ${t.name}（${t.systemKey}）已補建`)
    }
  }
  console.log('\n✅ 系統類型齊全。休息日發放/年假計算/OT兌換可正常運作。\n')
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); prisma.$disconnect(); process.exit(1) })

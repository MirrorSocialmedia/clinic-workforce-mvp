#!/usr/bin/env node
// purge-old-patient-names.mjs — 月度 PII 清理
// CostCase 完成滿 24 個月 → 自動清 patientName（留返 patientCode）
// 用法: node scripts/purge-old-patient-names.mjs [--dry-run]

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

if (dryRun) {
  console.log('🔍 Dry run mode — 不會實際修改數據')
}

async function main() {
  // 計算 24 個月前的日期
  const cutoff = new Date()
  cutoff.setMonth(cutoff.getMonth() - 24)

  console.log(`📅 清理閾值: ${cutoff.toISOString().slice(0, 10)} 之前的已完成 CostCase`)

  // 找出符合條件的記錄：status = DONE/VOID, orderedAt 超過 24 個月, patientName 不為 null
  const candidates = await prisma.costCase.findMany({
    where: {
      status: { in: ['DONE', 'VOID'] },
      orderedAt: { lte: cutoff },
      patientName: { not: null },
    },
    select: {
      id: true,
      patientCode: true,
      patientName: true,
      orderedAt: true,
      status: true,
      periodMonth: true,
    },
  })

  console.log(`📊 找到 ${candidates.length} 筆待清理記錄`)

  if (candidates.length === 0) {
    console.log('✅ 沒有需要清理的記錄')
    return
  }

  if (dryRun) {
    console.log('\n📋 待清理記錄:')
    for (const c of candidates.slice(0, 10)) {
      console.log(`  ${c.periodMonth} ${c.patientCode} "${c.patientName}" (${c.status})`)
    }
    if (candidates.length > 10) {
      console.log(`  ... 及其他 ${candidates.length - 10} 筆`)
    }
    return
  }

  // 實際清理
  const result = await prisma.costCase.updateMany({
    where: {
      id: { in: candidates.map(c => c.id) },
    },
    data: {
      patientName: null,
    },
  })

  console.log(`✅ 已清理 ${result.count} 筆記錄的 patientName`)

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: null, // system-generated
      action: 'PATIENT_NAME_PURGE',
      entity: 'CostCase',
      entityId: `PURGE_${new Date().toISOString().slice(0, 10)}`,
      beforeJson: JSON.stringify({ cutoff: cutoff.toISOString(), count: candidates.length }),
      afterJson: JSON.stringify({ purged: result.count }),
      notes: `月度 PII 清理: 清除 ${result.count} 筆超過 24 個月的病人姓名 (cutoff: ${cutoff.toISOString().slice(0, 10)})`,
    },
  } as any)

  console.log('📝 Audit 記錄已寫入: PATIENT_NAME_PURGE')
}

main()
  .catch(e => {
    console.error('❌ 清理失敗:', e.message)
    process.exit(1)
  })
  .finally(() => {
    prisma.$disconnect()
  })

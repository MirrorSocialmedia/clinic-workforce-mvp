/**
 * cwm-tbfix-20260910 — 歷史 TimeBankLedgerSnapshot 一次性補做腳本（runbook 階段 5）
 *
 * 背景：新表存在之前已 FINALIZED 嘅月份冇 snapshot → 帳本顯示「⏳ 即時計算」，
 *   仲會隨打卡更正而變，同「証明記錄」定位相反。
 * ❌ 唔好用「退回草稿 → 重新確認」—— 會刪咗 ROSTER_DIFF 同 LeaveBalanceSnapshot 再重建。
 *
 * 零副作用：淨係 upsert "TimeBankLedgerSnapshot"；唔動 TimeBankEntry / PayrollItem /
 *   LeaveBalanceSnapshot 等任何業務表。
 *   （calculateTimeBank 讀取路徑固有會寫 TimeBank **純快取** —— 同員工總覽讀取一樣，
 *    無業務影響；runbook 回滾章明示「TimeBank 純快取，唔使還原」。）
 *
 * cfg 來源同 finalize 完全一致（cwm-tbfix-20260910 修完後口徑）：
 *   payRules = PAY_RULE_LATEST（isActive + effectiveFrom/createdAt desc + take 1）+ select payType/configJson，
 *   `base_type === 'hourly'` skip（時薪唔設時間帳戶）。
 *
 * 冪等：已有 snapshot 且 opening/closing/linesJson/engineVersion 全一致 → skip（保留原 frozenAt）；
 *   有差異 → 覆寫刷新（frozenBy = 'backfill-tb-ledger' 標記）。
 *
 * Usage（app container workdir = apps/web）:
 *   docker compose -p clinic -f docker-compose.yml exec app \
 *     npx tsx scripts/backfill-tb-ledger.ts 2026-06 2026-08 --dry-run
 *   # 全部 reconciles=true 先真跑：
 *   docker compose -p clinic -f docker-compose.yml exec app \
 *     npx tsx scripts/backfill-tb-ledger.ts 2026-06 2026-08
 * 本地:
 *   DATABASE_URL="postgresql://..." npx tsx scripts/backfill-tb-ledger.ts 2026-08 --dry-run
 */
import { PrismaClient } from '@prisma/client'
import { PAY_RULE_SELECT } from '../src/lib/pay-rule-latest'
import { buildTimeBankLedger } from '../src/lib/timebank-ledger'
import { TIMEBANK_ENGINE_VERSION } from '../src/lib/payroll-engine'

const FROZEN_BY = 'backfill-tb-ledger' // frozenBy 審計標記（非 user id — 非人手操作）

function usage(code: number): never {
  console.error('Usage: backfill-tb-ledger.ts <YYYY-MM> [YYYY-MM ...] [--dry-run]')
  process.exit(code)
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const months = args.filter(a => !a.startsWith('--'))
  if (months.length === 0 || months.some(m => !/^\d{4}-(0[1-9]|1[0-2])$/.test(m))) usage(1)
  if (!process.env.DATABASE_URL) {
    console.error('✗ DATABASE_URL 未設')
    process.exit(1)
  }

  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
  console.log(`[backfill-tb-ledger] months=${months.join(', ')} ${dryRun ? '（DRY-RUN，唔會寫入）' : '（真跑）'} engineVersion=${TIMEBANK_ENGINE_VERSION}`)

  let totalWouldWrite = 0
  let totalSkipped = 0
  const nonReconciledEmps: string[] = []

  for (const pm of months) {
    // ★ 該月有 FINALIZED PayrollRun 嘅員工（periodMonth 存 HK 月首日 — 同 finalize 寫入口徑）
    const monthStart = new Date(`${pm}-01T00:00:00+08:00`)
    const runs = await prisma.payrollRun.findMany({
      where: { status: 'FINALIZED', periodMonth: monthStart },
      select: { id: true },
    })
    if (runs.length === 0) {
      console.log(`\n== ${pm}：冇 FINALIZED run，skip`)
      continue
    }
    const items = await prisma.payrollItem.findMany({
      where: { runId: { in: runs.map(r => r.id) } },
      select: {
        employeeId: true,
        employee: { select: { id: true, payRules: PAY_RULE_SELECT } },
      },
    })

    // 同一個月多 run 重複 → 按 employeeId 去重
    const byEmp = new Map<string, any>()
    for (const it of items) {
      if (!byEmp.has(it.employeeId)) byEmp.set(it.employeeId, it.employee)
    }
    console.log(`\n== ${pm}：${runs.length} run(s) / ${byEmp.size} 名員工`)

    let wrote = 0
    let skipped = 0
    for (const [empId, emp] of byEmp) {
      let cfg: any = {}
      try { cfg = JSON.parse(emp.payRules?.[0]?.configJson || '{}') } catch { /* 壞 JSON 當冇 config */ }
      if (cfg?.base_type === 'hourly') {
        console.log(`  - ${empId} 時薪（base_type=hourly）→ skip`)
        continue
      }

      const ledger = await buildTimeBankLedger(prisma, empId, pm, cfg)
      const lineSum = ledger.lines.reduce((s: number, l: any) => s + (Number(l.minutes) || 0), 0)
      const reconciled = ledger.reconciles && ledger.opening + lineSum === ledger.closing
      if (!reconciled) nonReconciledEmps.push(`${empId}（${pm}）`)

      const existing = await prisma.timeBankLedgerSnapshot.findUnique({
        where: { employeeId_periodMonth: { employeeId: empId, periodMonth: pm } },
      })
      const linesJson = JSON.stringify(ledger.lines)
      const identical = existing
        && existing.opening === ledger.opening
        && existing.closing === ledger.closing
        && existing.linesJson === linesJson
        && existing.engineVersion === TIMEBANK_ENGINE_VERSION

      if (identical) {
        console.log(`  = ${empId} opening=${ledger.opening} closing=${ledger.closing} reconciles=${reconciled ? 'true' : 'FALSE ⚠️'}（snapshot 已一致 → skip）`)
        skipped++
        continue
      }

      console.log(`  ${dryRun ? '~' : '+'} ${empId} opening=${ledger.opening} closing=${ledger.closing} reconciles=${ledger.reconciles ? 'true' : 'FALSE ⚠️'}${existing ? '（snapshot 有差異 → 刷新）' : '（新增）'}`)
      if (dryRun) {
        wrote++
        continue
      }
      await prisma.timeBankLedgerSnapshot.upsert({
        where: { employeeId_periodMonth: { employeeId: empId, periodMonth: pm } },
        update: {
          opening: ledger.opening,
          closing: ledger.closing,
          linesJson,
          engineVersion: TIMEBANK_ENGINE_VERSION,
          frozenAt: new Date(),
          frozenBy: FROZEN_BY,
        },
        create: {
          employeeId: empId,
          periodMonth: pm,
          opening: ledger.opening,
          closing: ledger.closing,
          linesJson,
          engineVersion: TIMEBANK_ENGINE_VERSION,
          frozenBy: FROZEN_BY,
        },
      })
      wrote++
    }
    totalWouldWrite += wrote
    totalSkipped += skipped
  }

  console.log(`\n[backfill-tb-ledger] ${dryRun ? 'dry-run' : '完成'}：${dryRun ? '會寫' : '已寫'} ${totalWouldWrite} 行，skip（已一致）${totalSkipped} 行`)
  if (nonReconciledEmps.length > 0) {
    console.log(`⚠️ rebuild 有未分類差額（reconciles=false，帳本含 UNEXPLAINED 補差行）：${nonReconciledEmps.join(', ')}`)
    console.log('   同現行 finalize 行為一致（會照寫 snapshot）；已知口徑差（如 D3 補鐘雙重計）可接受，其餘請先核對再真跑（runbook：全部 reconciles=true 先真跑）')
  }
  await prisma.$disconnect()
}

main().catch(e => {
  console.error('[backfill-tb-ledger] 失敗：', e)
  process.exit(1)
})

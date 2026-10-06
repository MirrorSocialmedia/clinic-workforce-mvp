/**
 * cwm-tbmonthrule-20261006 — 修正「兼職月份被當月薪計時間帳戶」嘅舊數據
 *
 * 背景：確認計糧（payroll-runs/[id] PUT FINALIZED）之前用【最新】薪酬規則判斷月薪／時薪。
 *   員工 9 月兼職、10 月轉全職 → 9 月確認計糧時最新規則已係月薪 →
 *     ① 寫咗一筆 9 月 ROSTER_DIFF（編更差額，實例 −4,620 分鐘 =「已編班 85h − 應返 162h」）
 *     ② 凍結咗 9 月時間帳戶帳本（TimeBankLedgerSnapshot），入面仲有 OT／遲到早退推導行
 *     ③ 10 月期初接咗 9 月錯嘅期末（−4,333）
 *   程式已改為用【嗰個月生效】嘅規則（findPayRuleForMonth），呢個腳本清返已經寫咗嘅錯數。
 *
 * 判斷（只睇規則，唔睇其他）：嗰個月生效規則 = 時薪（base_type hourly）或 payType ≠ MONTHLY
 *   → 該月 ROSTER_DIFF 唔應該存在 → 刪
 *   → 該月係時薪 → 唔應該有凍結帳本 → 刪（之後即時計：冇 OT／遲到推導，只計實體 entry）
 *   → 之後月份如果已凍結：期初／期末按差額平移（逐行明細唔郁），並列出嚟提醒覆核該月糧單
 *   → 清 TimeBank 純快取（由該月起），下次讀即時重算
 *   嗰個月冇任何規則覆蓋 → 唔郁（人手睇）
 *
 * 預設 DRY-RUN（淨係列出）；加 --apply 先寫，一個 transaction，每人每月一筆 AuditLog（TIMEBANK_REPAIR_HOURLY_MONTH）。
 *
 * Usage（app container workdir = apps/web）:
 *   docker compose -p clinic -f docker-compose.yml exec app npx tsx scripts/repair-tb-hourly-months.ts
 *   docker compose -p clinic -f docker-compose.yml exec app npx tsx scripts/repair-tb-hourly-months.ts --apply
 */
import { PrismaClient } from '@prisma/client'
import { findPayRulesForMonth, isHourlyRule } from '../src/lib/pay-rule-for-month'
import { calculateTimeBank } from '../src/lib/payroll-engine'
import { getMonthRange, toHKDateStr } from '../src/lib/hk-date'
import { rosterDiffNoteFilter } from '../src/lib/roster-hours'

const MARK = 'repair-tb-hourly-months'

const monthBounds = (pm: string) => getMonthRange(new Date(`${pm}-01T00:00:00+08:00`))

async function main() {
  const apply = process.argv.includes('--apply')
  if (!process.env.DATABASE_URL) {
    console.error('✗ DATABASE_URL 未設')
    process.exit(1)
  }
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })
  console.log(`[${MARK}] ${apply ? '★ 真跑（--apply）' : 'DRY-RUN（唔會寫入；確認冇問題再加 --apply）'}`)

  // ① 候選 (員工, 月份)：有 ROSTER_DIFF 或者有凍結帳本嘅
  const rd = await prisma.timeBankEntry.findMany({
    where: { type: 'ROSTER_DIFF' },
    select: { id: true, employeeId: true, date: true, minutes: true, note: true },
  })
  const snaps = await prisma.timeBankLedgerSnapshot.findMany({
    select: { employeeId: true, periodMonth: true, opening: true, closing: true },
  })
  const byMonth = new Map<string, Set<string>>()
  const add = (pm: string, emp: string) => { if (!byMonth.has(pm)) byMonth.set(pm, new Set()); byMonth.get(pm)!.add(emp) }
  for (const e of rd) add(toHKDateStr(e.date).slice(0, 7), e.employeeId)
  for (const s of snaps) add(s.periodMonth, s.employeeId)

  // ② 逐月用【嗰個月】規則判斷
  type Fix = { employeeId: string; pm: string; rosterIds: string[]; rosterMinutes: number; dropSnapshot: boolean; oldClosing: number | null; reason: string }
  const fixes: Fix[] = []
  for (const pm of [...byMonth.keys()].sort()) {
    const { start, end } = monthBounds(pm)
    const emps = [...byMonth.get(pm)!]
    const rules = await findPayRulesForMonth(prisma, emps, start, end)
    for (const emp of emps) {
      const rule = rules.get(emp)
      if (!rule) continue // 冇規則覆蓋 → 唔郁
      const hourly = isHourlyRule(rule)
      const notMonthly = hourly || rule.payType !== 'MONTHLY'
      if (!notMonthly) continue
      const rosterRows = rd.filter(e => e.employeeId === emp && toHKDateStr(e.date).slice(0, 7) === pm)
      const snap = snaps.find(s => s.employeeId === emp && s.periodMonth === pm)
      const dropSnapshot = hourly && !!snap
      if (rosterRows.length === 0 && !dropSnapshot) continue
      fixes.push({
        employeeId: emp, pm,
        rosterIds: rosterRows.map(r => r.id),
        rosterMinutes: rosterRows.reduce((s, r) => s + r.minutes, 0),
        dropSnapshot,
        oldClosing: snap?.closing ?? null,
        reason: hourly ? '嗰個月係時薪（兼職）' : `嗰個月 payType=${rule.payType}`,
      })
    }
  }

  if (fixes.length === 0) {
    console.log('✓ 冇需要修正嘅記錄')
    await prisma.$disconnect()
    return
  }

  const names = new Map((await prisma.employee.findMany({
    where: { id: { in: [...new Set(fixes.map(f => f.employeeId))] } },
    select: { id: true, user: { select: { name: true } } },
  })).map(e => [e.id, e.user?.name ?? e.id]))

  for (const f of fixes) {
    const later = snaps.filter(s => s.employeeId === f.employeeId && s.periodMonth > f.pm).map(s => s.periodMonth).sort()
    console.log(`\n• ${names.get(f.employeeId)}（${f.employeeId}）${f.pm} — ${f.reason}`)
    if (f.rosterIds.length) console.log(`   刪 ROSTER_DIFF ${f.rosterIds.length} 筆，合共 ${f.rosterMinutes} 分鐘`)
    if (f.dropSnapshot) console.log(`   刪凍結帳本（舊期末 ${f.oldClosing}）→ 改即時計（唔計 OT／遲到早退）`)
    if (later.length) console.log(`   ⚠ 之後已凍結月份：${later.join('、')} —— 期初／期末會按差額平移，請覆核嗰幾個月糧單`)
  }

  if (!apply) {
    console.log(`\nDRY-RUN 完：${fixes.length} 項。確認冇問題再加 --apply`)
    await prisma.$disconnect()
    return
  }

  await prisma.$transaction(async (tx) => {
    for (const f of fixes) {
      const { start } = monthBounds(f.pm)
      // 修正前期末（凍結就用凍結值，否則即時計）
      const before = f.oldClosing ?? (await calculateTimeBank(f.employeeId, start, {}, tx)).balance

      if (f.rosterIds.length) {
        await tx.timeBankEntry.deleteMany({
          where: { id: { in: f.rosterIds }, type: 'ROSTER_DIFF', note: rosterDiffNoteFilter(f.pm) },
        })
      }
      if (f.dropSnapshot) {
        await tx.timeBankLedgerSnapshot.delete({ where: { employeeId_periodMonth: { employeeId: f.employeeId, periodMonth: f.pm } } })
      }
      // TimeBank 純快取：由該月起清走，之後即時重算
      await tx.timeBank.deleteMany({ where: { employeeId: f.employeeId, periodMonth: { gte: start } } })

      // 修正後期末：仍有凍結帳本 → 期末減返刪咗嘅 ROSTER_DIFF；冇 → 即時計
      let after: number
      if (!f.dropSnapshot && f.oldClosing !== null) {
        after = f.oldClosing - f.rosterMinutes
        const snap = await tx.timeBankLedgerSnapshot.findUnique({ where: { employeeId_periodMonth: { employeeId: f.employeeId, periodMonth: f.pm } } })
        if (snap) {
          let lines: any[] = []
          try { lines = JSON.parse(snap.linesJson) } catch { lines = [] }
          lines = lines.filter(l => !(l.type === 'ROSTER_DIFF' && f.rosterIds.includes(l.entryId)))
          await tx.timeBankLedgerSnapshot.update({
            where: { id: snap.id },
            data: { closing: after, linesJson: JSON.stringify(lines), frozenBy: MARK },
          })
        }
      } else {
        after = (await calculateTimeBank(f.employeeId, start, {}, tx)).balance
      }
      const delta = after - before

      // 之後已凍結月份：期初／期末平移（逐行明細唔郁 —— 本身冇錯，只係接錯咗期初）
      const later = await tx.timeBankLedgerSnapshot.findMany({
        where: { employeeId: f.employeeId, periodMonth: { gt: f.pm } },
      })
      if (delta !== 0) {
        for (const s of later) {
          await tx.timeBankLedgerSnapshot.update({
            where: { id: s.id },
            data: { opening: s.opening + delta, closing: s.closing + delta, frozenBy: MARK },
          })
        }
      }

      await tx.auditLog.create({
        data: {
          actorId: null,
          action: 'TIMEBANK_REPAIR_HOURLY_MONTH',
          entity: 'TimeBankLedgerSnapshot',
          entityId: `${f.employeeId}:${f.pm}`,
          targetEmployeeId: f.employeeId,
          beforeJson: JSON.stringify({ closing: before, rosterDiffIds: f.rosterIds, rosterMinutes: f.rosterMinutes, snapshotDropped: f.dropSnapshot }),
          afterJson: JSON.stringify({ closing: after, delta, laterShifted: delta !== 0 ? later.map(s => s.periodMonth) : [] }),
          notes: `${MARK}：${f.pm} ${f.reason} —— 唔應該有編更差額／時間帳戶推導（舊版用最新規則判斷）`,
        },
      })
      console.log(`✓ ${names.get(f.employeeId)} ${f.pm}：期末 ${before} → ${after}（差 ${delta}）`)
    }
  }, { timeout: 60000 })

  console.log(`\n完成：${fixes.length} 項已修正`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })

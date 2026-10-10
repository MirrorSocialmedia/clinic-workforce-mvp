/**
 * cwm-otbackpay-20261010 — 搵返「OT 門檻設錯」少計嘅 OT，補回去指定月份
 *
 * 背景：大圍員工規則曾設「每日 OT 滿 15 分鐘先計」，實際冇呢個限制；8、9 月已確認計糧出糧。
 * 做法：唔郁已出糧月份；喺補回月份（例如 10 月）每人每個來源月份寫一筆 TimeBankEntry(OT_BACKPAY)。
 *   少計幾多 = 同一份打卡／更表用同一個引擎計兩次（門檻 15 vs 不限），逐日相減（lib/timebank-ot-backpay.ts）。
 *
 * 揀人：嗰個月有確認計糧（FINALIZED／EXPORTED）、嗰個月生效規則唔係時薪，而且
 *   ① 規則而家仲設住 ot_min_minutes > 0；或 ② 屬於 --clinic 指定嘅診所（規則已經原地改走都搵得返）。
 *
 * 預設 DRY-RUN：只列出，唔寫任何嘢（每次計算包喺 transaction 入面最後 rollback，連快取都唔留）。
 * --apply --to YYYY-MM：寫入，一個 transaction，每筆一條 AuditLog（TIMEBANK_OT_BACKPAY）；
 *   已補過（note 有 [otbp:YYYY-MM]）自動跳過；補回月份已確認計糧嘅員工跳過（要人手處理）。
 *
 * Usage（正式機：用 builder image，app container 冇 tsx／scripts）:
 *   docker run --rm --network clinic_clinic_net \
 *     -e DATABASE_URL="$(docker compose -p clinic -f docker-compose.yml exec -T app printenv DATABASE_URL)" \
 *     -w /app/apps/web clinic-builder \
 *     npx tsx scripts/ot-threshold-backpay.ts 2026-08 2026-09 --clinic 大圍 [--threshold 15] [--csv /tmp/x.csv]
 *   確認冇問題再加：--apply --to 2026-10
 */
import fs from 'fs'
import { PrismaClient } from '@prisma/client'
import { findPayRulesForMonth, isHourlyRule } from '../src/lib/pay-rule-for-month'
import { findOtBackpay, otBackpayNote, otBackpayTag, type OtBackpayDay } from '../src/lib/timebank-ot-backpay'
import { getMonthRange } from '../src/lib/hk-date'

const MARK = 'ot-threshold-backpay'
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const ROLLBACK = Symbol('rollback')

function argVal(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const to = argVal(args, '--to')
  const clinicArg = argVal(args, '--clinic')
  const threshold = Number(argVal(args, '--threshold') ?? 15)
  const csvPath = argVal(args, '--csv')
  const valued = new Set(['--to', '--clinic', '--threshold', '--csv'].map(n => argVal(args, n)).filter(Boolean) as string[])
  const months = args.filter(a => !a.startsWith('--') && !valued.has(a))
  if (months.length === 0 || months.some(m => !MONTH_RE.test(m)) || !Number.isFinite(threshold) || threshold <= 0) {
    console.error('Usage: ot-threshold-backpay.ts <YYYY-MM>... [--clinic 名] [--threshold 15] [--csv path] [--apply --to YYYY-MM]')
    process.exit(1)
  }
  if (apply && (!to || !MONTH_RE.test(to) || months.some(m => m >= to))) {
    console.error('✗ --apply 要配 --to YYYY-MM，而且要遲過所有來源月份')
    process.exit(1)
  }
  if (!process.env.DATABASE_URL) { console.error('✗ DATABASE_URL 未設'); process.exit(1) }
  const prisma = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL })

  let clinic: { id: string; name: string } | null = null
  if (clinicArg) {
    clinic = await prisma.clinic.findFirst({
      where: { OR: [{ id: clinicArg }, { shortName: clinicArg }, { name: clinicArg }] },
      select: { id: true, name: true },
    })
    if (!clinic) { console.error(`✗ 搵唔到診所：${clinicArg}`); process.exit(1) }
  }
  console.log(`[${MARK}] 來源月份 ${months.join('、')}｜當時門檻 ${threshold} 分鐘｜${clinic ? `診所 ${clinic.name}` : '只揀規則仲設住門檻嘅員工'}｜${apply ? `★ 真跑，補回去 ${to}` : 'DRY-RUN（唔寫入）'}`)

  type Found = { employeeId: string; name: string; month: string; days: OtBackpayDay[]; total: number; warn: string[] }
  const found: Found[] = []

  for (const pm of months) {
    const { start, end } = getMonthRange(new Date(`${pm}-01T00:00:00+08:00`))
    const runs = await prisma.payrollRun.findMany({
      where: { periodMonth: { gte: start, lte: end }, status: { in: ['FINALIZED', 'EXPORTED'] as any } },
      select: { id: true },
    })
    if (runs.length === 0) { console.log(`\n== ${pm}：冇已確認計糧，跳過`); continue }
    const items = await prisma.payrollItem.findMany({
      where: { runId: { in: runs.map(r => r.id) } },
      select: {
        employeeId: true,
        employee: {
          select: {
            homeClinicId: true, attendanceExempt: true,
            clinics: { select: { clinicId: true } },
            user: { select: { name: true } },
          },
        },
      },
    })
    const empIds = [...new Set(items.map(i => i.employeeId))]
    const rules = await findPayRulesForMonth(prisma, empIds, start, end)
    for (const empId of empIds) {
      const it = items.find(i => i.employeeId === empId)!
      const rule = rules.get(empId)
      if (!rule || isHourlyRule(rule) || it.employee.attendanceExempt) continue
      let cfg: any = {}
      try { cfg = JSON.parse(rule.configJson || '{}') } catch { /* 壞 JSON */ }
      const ruleMin = Number(cfg?.modifiers?.overtime?.ot_min_minutes ?? 0)
      const inClinic = !!clinic && (it.employee.homeClinicId === clinic.id || it.employee.clinics.some((c: any) => c.clinicId === clinic!.id))
      if (!(ruleMin > 0 || inClinic)) continue

      // 計算包喺 transaction，最後 rollback —— dry-run／真跑都唔會留低任何快取
      let res: Awaited<ReturnType<typeof findOtBackpay>> | null = null
      try {
        await prisma.$transaction(async tx => {
          res = await findOtBackpay(tx, empId, pm, threshold)
          throw ROLLBACK
        }, { timeout: 120000 })
      } catch (e) { if (e !== ROLLBACK) throw e }
      const r = res as Awaited<ReturnType<typeof findOtBackpay>> | null
      if (!r) continue
      const warn: string[] = []
      if (r.degraded) warn.push('讀取資料唔完整（degraded），請重跑')
      if (ruleMin > 0 && ruleMin !== threshold) warn.push(`規則而家門檻係 ${ruleMin}，唔係 ${threshold}`)
      const neg = cfg?.modifiers?.time_bank?.negative_carry
      if (neg === 'deduct_salary' || neg === 'deduct_bonus') warn.push(`規則設咗負數${neg === 'deduct_salary' ? '扣糧' : '扣勤工'} —— 少計 OT 可能令當月多扣錢，要人手覆核`)
      if (r.totalMinutes > 0 || warn.length) {
        found.push({ employeeId: empId, name: it.employee.user?.name ?? empId, month: pm, days: r.days, total: r.totalMinutes, warn })
      }
    }
  }

  if (found.length === 0) { console.log('\n✓ 搵唔到少計嘅 OT'); await prisma.$disconnect(); return }

  for (const f of found) {
    console.log(`\n• ${f.name}（${f.employeeId}）${f.month}：${f.days.length} 日，少計 ${f.total} 分鐘`)
    for (const d of f.days) console.log(`    ${d.date}　當時計 ${d.credited}　應計 ${d.correct}　補回 +${d.diff}`)
    for (const w of f.warn) console.log(`    ⚠ ${w}`)
  }
  const byEmp = new Map<string, number>()
  for (const f of found) byEmp.set(f.name, (byEmp.get(f.name) ?? 0) + f.total)
  console.log('\n── 每人合計 ──')
  for (const [n, m] of byEmp) console.log(`  ${n}：${m} 分鐘（${(m / 60).toFixed(2)} 小時）`)

  if (csvPath) {
    const lines = ['員工,月份,日期,當時計(分鐘),應計(分鐘),補回(分鐘)']
    for (const f of found) for (const d of f.days) lines.push([f.name, f.month, d.date, d.credited, d.correct, d.diff].join(','))
    fs.writeFileSync(csvPath, '﻿' + lines.join('\n'))
    console.log(`\nCSV：${csvPath}`)
  }

  if (!apply) {
    console.log('\nDRY-RUN 完。確認冇問題再加：--apply --to YYYY-MM')
    await prisma.$disconnect()
    return
  }

  const { start: toStart, end: toEnd } = getMonthRange(new Date(`${to}-01T00:00:00+08:00`))
  let written = 0
  for (const f of found) {
    if (f.total <= 0) continue
    const finalizedInTarget = await prisma.payrollItem.findFirst({
      where: { employeeId: f.employeeId, run: { periodMonth: { gte: toStart, lte: toEnd }, status: { in: ['FINALIZED', 'EXPORTED'] as any } } },
      select: { id: true },
    })
    if (finalizedInTarget) { console.log(`✗ 跳過 ${f.name} ${f.month}：${to} 已確認計糧，要人手處理`); continue }
    const dup = await prisma.timeBankEntry.findFirst({
      where: { employeeId: f.employeeId, type: 'OT_BACKPAY', note: { contains: otBackpayTag(f.month) } },
      select: { id: true },
    })
    if (dup) { console.log(`－ 跳過 ${f.name} ${f.month}：已經補過`); continue }

    await prisma.$transaction(async tx => {
      const e = await tx.timeBankEntry.create({
        data: {
          employeeId: f.employeeId, date: toStart, type: 'OT_BACKPAY', minutes: f.total,
          note: otBackpayNote(f.month, threshold, f.days), createdBy: MARK,
        },
      })
      await tx.timeBank.deleteMany({ where: { employeeId: f.employeeId, periodMonth: { gte: toStart } } }) // 純快取
      await tx.auditLog.create({
        data: {
          actorId: null, action: 'TIMEBANK_OT_BACKPAY', entity: 'TimeBankEntry', entityId: e.id,
          targetEmployeeId: f.employeeId,
          afterJson: JSON.stringify({ sourceMonth: f.month, targetMonth: to, minutes: f.total, threshold, days: f.days }),
          notes: `${MARK}：補回 ${f.month} 少計 OT ${f.total} 分鐘（記入 ${to}）`,
        },
      })
    })
    written++
    console.log(`✓ ${f.name}：補回 ${f.month} ${f.total} 分鐘 → ${to}`)
  }
  console.log(`\n完成：寫入 ${written} 筆`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })

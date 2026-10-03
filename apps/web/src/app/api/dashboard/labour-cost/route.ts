export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { getMonthRange, toHKDateStr } from '@/lib/hk-date'
import { PAY_RULE_SELECT } from '@/lib/pay-rule-latest'
import { jsonNoStore } from '@/lib/api-response'
import { estimateScheduledHours } from '@/lib/shift-punch-match'
import { employedFromWhere } from '@/lib/employment-scope'

/**
 * GET /api/dashboard/labour-cost?month=YYYY-MM — ★ cwm-ownerdash-20260917：OWNER-only 人工卡
 *
 * ★ cwm-labourfix-20261003：舊版只計「本月」糧單 —— 但糧單係月尾／下月初先出，
 *   成個月大部分時間本月都未有糧單 → 卡永遠 $0。而家分兩部分：
 *   ① latest：最近一期有糧單嘅月份（≤ 本月）實數（Gross／Net／僱員 MPF），同再上一期已確認比較
 *   ② estimate：本月未入糧單嘅人預計 —— 月薪 = 底薪；時薪 = 本月排更鐘數 × 時薪
 *      （未計 OT／津貼／扣款／MPF；本月糧單出咗嘅人唔重複估）
 */
const prevMonth = (ym: string) => {
  const [y, m] = ym.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') { // ROLE-OK: 全公司人工總額只限負責人（唔可以經權限開）
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const ym = new URL(req.url).searchParams.get('month') || toHKDateStr(new Date()).slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(ym)) return NextResponse.json({ error: 'month 格式 YYYY-MM' }, { status: 400 })
  const { start: monthStart, end: monthEnd } = getMonthRange(new Date(`${ym}-01T00:00:00+08:00`))

  const summarize = async (month: string) => {
    const { start, end } = getMonthRange(new Date(`${month}-01T00:00:00+08:00`))
    const runs = await prisma.payrollRun.findMany({
      where: { periodMonth: { gte: start, lte: end } },
      select: { id: true, status: true, clinic: { select: { name: true } },
        items: { select: { employeeId: true, totalPayable: true, detailJson: true } } },
    })
    const byRun = runs.map(r => {
      let gross = 0, mpf = 0
      for (const it of r.items) {
        try {
          const d = JSON.parse(it.detailJson || '{}')
          gross += Number(d.grossPay ?? d.salary?.grossPay) || 0
          mpf += Number(d.mpf ?? d.salary?.mpf) || 0
        } catch (e) { console.error('[labour-cost] bad detailJson', r.id, e) }
      }
      const net = r.items.reduce((s, it) => s + (it.totalPayable ?? 0), 0)
      return { runId: r.id, clinicName: r.clinic?.name ?? '全部診所', status: r.status, headcount: r.items.length,
        gross: Math.round(gross * 100) / 100, net: Math.round(net * 100) / 100, mpfEmployee: Math.round(mpf * 100) / 100 }
    })
    const inRun = new Set(runs.flatMap(r => r.items.map(i => i.employeeId)))
    const sum = (k: 'gross' | 'net' | 'mpfEmployee') => Math.round(byRun.reduce((s, r) => s + r[k], 0) * 100) / 100
    return { month, runs: byRun, totals: { gross: sum('gross'), net: sum('net'), mpfEmployee: sum('mpfEmployee') }, inRun }
  }

  // ① 最近一期有糧單嘅月份（≤ 本月）
  const latestRun = await prisma.payrollRun.findFirst({
    where: { periodMonth: { lte: monthEnd } },
    orderBy: { periodMonth: 'desc' },
    select: { periodMonth: true },
  })
  const latestYm = latestRun ? toHKDateStr(latestRun.periodMonth).slice(0, 7) : null
  const latest = latestYm ? await summarize(latestYm) : null
  const beforeLatest = latestYm ? await summarize(prevMonth(latestYm)) : null
  const current = latestYm === ym ? latest! : await summarize(ym)

  // ② 本月預計（未入本月糧單、本月仍受僱、本月或之前入職）
  const emps = await prisma.employee.findMany({
    where: { AND: [employedFromWhere(monthStart), { joinDate: { lte: monthEnd } }] },
    select: { id: true, payRules: PAY_RULE_SELECT },
  })
  const hourlyRate = new Map<string, number>()
  const lunchMin = new Map<string, number>()
  let monthlyBase = 0, monthlyN = 0, noRuleN = 0
  for (const e of emps) {
    if (current.inRun.has(e.id)) continue
    const r = (e as any).payRules?.[0]
    if (!r) { noRuleN++; continue }
    let cfg: any = {}
    try { cfg = JSON.parse(r.configJson || '{}') } catch (err) { console.error('[labour-cost] bad configJson', e.id, err) }
    if (cfg.base_type === 'hourly' || r.payType === 'HOURLY') {
      hourlyRate.set(e.id, Number(cfg.hourly_rate) || 0)
      lunchMin.set(e.id, cfg?.modifiers?.lunch_break?.defaultMinutes ?? 60)
    } else {
      monthlyN++
      monthlyBase += Number(cfg.monthly_salary) || 0
    }
  }
  let hourlyAmount = 0, hourlyHours = 0, hourlyN = 0
  if (hourlyRate.size > 0) {
    const shifts = await prisma.shift.findMany({
      where: { employeeId: { in: [...hourlyRate.keys()] }, status: { not: 'CANCELLED' }, date: { gte: monthStart, lte: monthEnd } },
      select: { employeeId: true, date: true, startTime: true, endTime: true, status: true, template: { select: { deductLunch: true } } },
    })
    const est = estimateScheduledHours(shifts, id => lunchMin.get(id) ?? 60)
    for (const [empId, days] of est) {
      const h = days.reduce((s, d) => s + d.hours, 0)
      if (h <= 0) continue
      hourlyN++
      hourlyHours += h
      hourlyAmount += h * (hourlyRate.get(empId) ?? 0)
    }
  }
  const r2 = (n: number) => Math.round(n * 100) / 100

  return jsonNoStore({
    month: ym,
    latest: latest ? { month: latest.month, runs: latest.runs, totals: latest.totals } : null,
    beforeLatest: beforeLatest ? { month: beforeLatest.month, runs: beforeLatest.runs, totals: beforeLatest.totals } : null,
    estimate: {
      month: ym,
      inRunN: current.inRun.size,
      monthlyN, monthlyBase: r2(monthlyBase),
      hourlyN, hourlyHours: Math.round(hourlyHours * 10) / 10, hourlyAmount: r2(hourlyAmount),
      noRuleN,
      total: r2(monthlyBase + hourlyAmount),
    },
  })
}

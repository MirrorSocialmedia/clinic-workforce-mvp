export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { getMonthRange, toHKDateStr } from '@/lib/hk-date'
import { PAY_RULE_SELECT } from '@/lib/pay-rule-latest'
import { jsonNoStore } from '@/lib/api-response'

// GET /api/dashboard/labour-cost?month=YYYY-MM — ★ cwm-ownerdash-20260917：OWNER-only 本月人工
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') { // ROLE-OK: 全公司人工總額只限負責人（唔可以經權限開）
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const ym = new URL(req.url).searchParams.get('month') || toHKDateStr(new Date()).slice(0, 7)
  if (!/^\d{4}-\d{2}$/.test(ym)) return NextResponse.json({ error: 'month 格式 YYYY-MM' }, { status: 400 })
  const prevYm = (() => { const [y, m] = ym.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}` })()

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
        try { const d = JSON.parse(it.detailJson || '{}'); gross += Number(d.grossPay) || 0; mpf += Number(d.mpf) || 0 }
        catch (e) { console.error('[labour-cost] bad detailJson', r.id, e) }
      }
      const net = r.items.reduce((s, it) => s + (it.totalPayable ?? 0), 0)
      return { runId: r.id, clinicName: r.clinic?.name ?? '全部診所', status: r.status, headcount: r.items.length,
        gross: Math.round(gross * 100) / 100, net: Math.round(net * 100) / 100, mpfEmployee: Math.round(mpf * 100) / 100 }
    })
    const inRun = new Set(runs.flatMap(r => r.items.map(i => i.employeeId)))
    const sum = (k: 'gross' | 'net' | 'mpfEmployee') => Math.round(byRun.reduce((s, r) => s + r[k], 0) * 100) / 100
    return { month, runs: byRun, totals: { gross: sum('gross'), net: sum('net'), mpfEmployee: sum('mpfEmployee') }, inRun }
  }

  const cur = await summarize(ym)
  const prev = await summarize(prevYm)

  // 未入糧單嘅在職員工 → 底薪估算（月薪）／時薪人數（唔估）
  const emps = await prisma.employee.findMany({
    where: { status: { not: 'RESIGNED' } },
    select: { id: true, payRules: PAY_RULE_SELECT },
  })
  let baseSalary = 0, monthlyN = 0, hourlyN = 0, noRuleN = 0
  for (const e of emps) {
    if (cur.inRun.has(e.id)) continue
    const r = (e as any).payRules?.[0]
    if (!r) { noRuleN++; continue }
    let cfg: any = {}
    try { cfg = JSON.parse(r.configJson || '{}') } catch (err) { console.error('[labour-cost] bad configJson', e.id, err) }
    if (cfg.base_type === 'hourly') hourlyN++
    else { monthlyN++; baseSalary += Number(cfg.monthly_salary) || 0 }
  }

  return jsonNoStore({
    month: ym,
    current: { runs: cur.runs, totals: cur.totals },
    notInRun: { monthlyN, hourlyN, noRuleN, baseSalaryEstimate: Math.round(baseSalary) },
    previous: { month: prevYm, runs: prev.runs, totals: prev.totals },
  })
}

export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { calculateTimeBank } from '@/lib/payroll-engine'
import { PAY_RULE_SELECT } from '@/lib/pay-rule-latest'
import { MANUAL_MONTH_RE } from '@/lib/timebank-manual'
import { todayHK } from '@/lib/hk-date'

// ★ cwm-tbmanual-20261017 ①：手動調整即時預覽
// GET /api/timebank/manual-adjust/preview?employeeId=&month=
//   回傳目標月份嘅而家 balance（calculateTimeBank —— 同帳本同一口徑，
//   ★ 唔係 entry 加總：上次 41131 分嘅坑）。畫面用佢顯示「而家 X → 調整後 Y」。
//   只限 OWNER（同調整本身）。
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') { // ROLE-OK: 預覽 = 薪酬資料，維持 OWNER-only
    return NextResponse.json({ error: '只有老闆可查看手動調整預覽' }, { status: 403 })
  }

  const params = new URL(req.url).searchParams
  const employeeId = (params.get('employeeId') || '').trim()
  const month = params.get('month') || todayHK().slice(0, 7)
  if (!employeeId) return NextResponse.json({ error: '需要 employeeId' }, { status: 400 })
  if (!MANUAL_MONTH_RE.test(month)) return NextResponse.json({ error: '月份格式必須係 YYYY-MM' }, { status: 400 })

  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, payRules: PAY_RULE_SELECT },
  })
  if (!emp) return NextResponse.json({ error: '找不到員工' }, { status: 404 })

  let cfg: any = {}
  try { cfg = JSON.parse(emp.payRules?.[0]?.configJson || '{}') } catch { /* 壞 JSON 當冇 config */ }

  const tb = await calculateTimeBank(employeeId, new Date(`${month}-01T00:00:00+08:00`), cfg, prisma)
  return NextResponse.json({ ok: true, employeeId, month, balance: tb.balance ?? 0 })
}

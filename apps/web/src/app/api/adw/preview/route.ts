import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { calculateADW, applyAdwPolicy } from '@/lib/adw'

// ============================================================
// GET /api/adw/preview?employeeId=xxx&date=2026-08-01
// Returns ADWResult for the given employee and date
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const date = searchParams.get('date')

  if (!employeeId) {
    return NextResponse.json({ error: 'employeeId required' }, { status: 400 })
  }

  // Check pay confidentiality + 攞現行 PayRule（政策計算需要）
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      payConfidential: true,
      payRules: {
        where: { isActive: true },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 1,
        select: { configJson: true },
      },
    },
  })

  if (!emp) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 })
  }

  if (emp.payConfidential && auth.session.role !== 'OWNER') {
    return NextResponse.json({ error: '無權查看此員工的薪酬資料' }, { status: 403 })
  }

  const specifiedDate = date ? new Date(`${date}T00:00:00+08:00`) : new Date()
  if (isNaN(specifiedDate.getTime())) {
    return NextResponse.json({ error: 'date 格式錯誤，應為 YYYY-MM-DD' }, { status: 400 })
  }

  try {
    const raw = await calculateADW(prisma, employeeId, specifiedDate)

    // ★ 同時回傳「條例原始值」同「計糧實際採用值」——
    //   兩者喺開咗 adw_policy 之後會唔同，UI 必須分得清，
    //   否則用家會攞條例值去對數然後以為計錯（2026-07-31 就撞過）。
    let cfg: any = {}
    try { cfg = JSON.parse(emp.payRules?.[0]?.configJson || '{}') } catch { /* 壞 JSON 當冇政策 */ }
    const monthlySalary = Number(cfg?.monthly_salary) || 0

    const policied = monthlySalary > 0
      ? applyAdwPolicy(raw.adw, monthlySalary, cfg?.adw_policy)
      : { adw: raw.adw, adwRaw: raw.adw, policyApplied: 'none' as const, currentEquivalent: 0 }

    return NextResponse.json({
      ...raw,                        // adw = 條例原始值（保持向後相容）
      effectiveAdw: policied.adw,    // ★ 計糧實際採用
      policyApplied: policied.policyApplied,
      currentEquivalent: policied.currentEquivalent,
      monthlySalary,
    })
  } catch (e: any) {
    console.error('[adw/preview]', e)
    return NextResponse.json(
      { error: `ADW 計算失敗：${e?.message || '未知錯誤'}` },
      { status: 500 },
    )
  }
}

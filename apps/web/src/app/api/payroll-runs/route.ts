export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { runWithAudit } from '@/lib/audit-context'
import { requirePerm, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope, getOwnHomeClinicId } from '@/lib/scope-helpers'
import { generatePayrollRun } from '@/lib/payroll-engine'
import { getMonthRange } from '@/lib/hk-date'

// ============================================================
// GET /api/payroll-runs — List payroll runs
// Roles: OWNER, MANAGER, ACCOUNTANT (payroll_view permission)
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requirePerm(req, 'payroll_view')
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const periodMonth = searchParams.get('periodMonth')
  const status = searchParams.get('status')
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '20', 10) || 20))
  const skip = (page - 1) * pageSize

  const where: any = {}

  if (clinicId) where.clinicId = clinicId
  if (status) where.status = status
  if (periodMonth) {
    const { start: monthStart, end: monthEnd } = getMonthRange(new Date(`${periodMonth}-01T00:00:00+08:00`))
    where.periodMonth = { gte: monthStart, lte: monthEnd }
  }

  // MANAGER only sees their clinics (own clinics + cross-store runs with null clinicId)
  const sessionClinics = session.clinics ?? []
  // ★ fail-closed：冇綁店的 MANAGER 應該乜都見不到，
  //   唔可以因為 sessionClinics 空就跳過 filter（會變成睇晒全公司計糧單）。
  //   exceptions route:46 已經咁做，呢度之前漏咗。
  if (scope === 'my-clinics') {
    if (sessionClinics.length === 0) {
      return NextResponse.json(
        { runs: [], total: 0, page, pageSize, totalPages: 0 },
        { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
      )
    }
    where.AND = [...(where.AND ?? []), {
      OR: [
        { clinicId: { in: sessionClinics } }, // 自己的診所（純字串陣列）
        { clinicId: null },                   // 跨店計糧（clinicId 為空）
      ],
    }]
  }

  const [runs, total] = await Promise.all([
    prisma.payrollRun.findMany({
      where,
      include: {
        clinic: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
      orderBy: { periodMonth: 'desc' },
      skip,
      take: pageSize,
    }),
    prisma.payrollRun.count({ where }),
  ])

  return NextResponse.json({
    runs,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  }, {
    headers: { 'Cache-Control': 'no-store, must-revalidate' },
  })
}

// ============================================================
// POST /api/payroll-runs — Generate payroll run
// Roles: OWNER, MANAGER (payroll_generate permission)
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requirePerm(req, 'payroll_generate')
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const auditCtx = {
    actorId: session.userId,
    ip: req.headers.get('x-forwarded-for') || undefined,
    ua: req.headers.get('user-agent') || undefined,
  }

  return runWithAudit(auditCtx, async () => {
    try {
      const body = await req.json()
      const { periodMonth, clinicId, storeBonuses, splitPays, attendanceBonusOverrides } = body

      if (!periodMonth) {
        return NextResponse.json({ error: 'periodMonth (YYYY-MM) is required' }, { status: 400 })
      }
      if (!clinicId) {
        return NextResponse.json({ error: '請指定店鋪（每店營業獎金不同，不支援全店合併生成）' }, { status: 400 })
      }

      // ★ 診所範圍限制（2026-08-03）
      const allowedClinics = await resolveClinicScope(session, auth.perms ?? [])
      if (allowedClinics !== null) {
        if (allowedClinics.length === 0) {
          return NextResponse.json(
            { error: '你冇主屬診所，無法生成計糧 —— 請聯絡帳戶擁有人設定' },
            { status: 403 },
          )
        }
        if (!clinicId) {
          return NextResponse.json(
            { error: '請指定診所（你只可以為主屬診所生成計糧）' },
            { status: 400 },
          )
        }
        if (!allowedClinics.includes(clinicId)) {
          return NextResponse.json(
            { error: '你只可以為主屬診所生成計糧' },
            { status: 403 },
          )
        }
      }

      // Validate storeBonuses if provided
      if (storeBonuses) {
        for (const [k, v] of Object.entries(storeBonuses)) {
          if (typeof v !== 'number' || !isFinite(v) || v < 0) {
            return NextResponse.json({ error: `Invalid storeBonus for ${k}: must be a finite non-negative number` }, { status: 400 })
          }
        }
      }

      // Validate splitPays if provided
      if (splitPays) {
        for (const [k, v] of Object.entries(splitPays)) {
          if (typeof v !== 'number' || !isFinite(v) || v < 0) {
            return NextResponse.json({ error: `Invalid splitPay for ${k}: must be a finite non-negative number` }, { status: 400 })
          }
        }
      }

      // ★ Validate attendanceBonusOverrides if provided
      if (attendanceBonusOverrides) {
        for (const [k, v] of Object.entries(attendanceBonusOverrides as Record<string, string>)) {
          if (v !== 'FORCE_ON' && v !== 'FORCE_OFF') {
            return NextResponse.json({ error: `Invalid attendanceBonusOverride for ${k}: must be FORCE_ON or FORCE_OFF` }, { status: 400 })
          }
        }
      }

      // ★ excludeConfidential: 同主屬診所嘅人唔需要排除保密員工（2026-08-03）
      const home = session.role === 'OWNER' ? null : await getOwnHomeClinicId(session.userId) // ROLE-OK: OWNER 全公司
      const excludeConfidential =
        session.role !== 'OWNER' &&                                   // ROLE-OK
        !(!!home && clinicId === home)

      const result = await generatePayrollRun(clinicId || null, periodMonth, auditCtx, {
        storeBonuses, splitPays, attendanceBonusOverrides: attendanceBonusOverrides as Record<string, 'FORCE_ON' | 'FORCE_OFF'> | undefined,
        excludeConfidential,
      })

      // FIX #2: If result has error field (e.g., CONFIRMED blocked), return 409
      if ((result as any).error) {
        return NextResponse.json(result, { status: 409 })
      }

      // ★ 計算被略過的保密員工數量
      const skipped = excludeConfidential
        ? await prisma.employee.count({ where: { payConfidential: true, status: 'ACTIVE' } })
        : 0

      return NextResponse.json({
        ...result,
        ...(skipped > 0 ? {
          notice: `已略過 ${skipped} 位薪酬保密員工，需由帳戶擁有人另行生成`,
        } : {}),
      }, { status: 201 })
    } catch (err: any) {
      console.error('Failed to generate payroll:', err)
      return NextResponse.json({ error: err.message || 'Internal error' }, { status: 500 })
    }
  })
}

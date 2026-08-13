import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, requirePerm, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'

// ============================================================
// GET /api/lab-discounts — List lab monthly discounts
// Roles: OWNER, MANAGER
// Query: ?labId=&periodMonth=
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const labId = searchParams.get('labId')
  const periodMonth = searchParams.get('periodMonth')

  const where: any = {}
  if (labId) where.labId = labId
  if (periodMonth) where.periodMonth = periodMonth

  const discounts = await prisma.labMonthlyDiscount.findMany({
    where,
    include: { lab: { select: { id: true, name: true } } },
    orderBy: [{ periodMonth: 'desc' }, { lab: { sortOrder: 'asc' } }],
  })

  return jsonNoStore({
    discounts: discounts.map(d => ({
      ...d,
      discountPct: Number(d.discountPct),
    })),
  })
}

// ============================================================
// POST /api/lab-discounts — Set a lab monthly discount
// Roles: OWNER (provider_payout via perm override)
// Body: { labId, periodMonth, discountPct, note? }
// ⚠️ Upsert: if labId+periodMonth exists, update
// ⚠️ 重算未鎖定 case 數量提示（前端自己查）
// ============================================================
export async function POST(req: NextRequest) {
  const permCheck = await requirePerm(req, 'provider_payout')
  if (isAuthError(permCheck)) return permCheck.error
  const { session } = permCheck

  const body = await req.json()
  const { labId, periodMonth, discountPct, note } = body

  if (!labId || !periodMonth || discountPct == null) {
    return NextResponse.json({ error: 'labId, periodMonth, discountPct are required' }, { status: 400 })
  }

  const discountPctNum = Number(discountPct)

  // Count unpriced unlocked cases that will be affected
  const affectedCount = await prisma.costCase.count({
    where: {
      labId,
      periodMonth,
      category: { in: ['LAB', 'INVISALIGN'] },
      lockedByRunId: null,
      status: { not: 'VOID' },
      baseCost: { not: null },
    },
  })

  // Upsert
  const result = await prisma.labMonthlyDiscount.upsert({
    where: { labId_periodMonth: { labId, periodMonth } },
    create: {
      labId,
      periodMonth,
      discountPct: discountPctNum,
      note: note || null,
      createdBy: session.userId,
    },
    update: {
      discountPct: discountPctNum,
      note: note || null,
    },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'LAB_DISCOUNT_SET',
      entity: 'LabMonthlyDiscount',
      entityId: result.id,
      beforeJson: null,
      afterJson: JSON.stringify({ labId, periodMonth, discountPct: discountPctNum, note }),
      notes: `設定 Lab 折扣: ${periodMonth} ${discountPctNum}% (影響 ${affectedCount} 筆未鎖定 case)`,
    },
  } as any)

  return NextResponse.json({
    discount: {
      ...result,
      discountPct: Number(result.discountPct),
    },
    affectedCount,
  }, { status: 201 })
}

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { jsonNoStore } from '@/lib/api-response'
import { toHKDateStr } from '@/lib/hk-date'

// ============================================================
// GET /api/cost-cases — List cost cases
// Roles: OWNER, MANAGER (cost_entry via perm override)
// Query: ?providerId=&periodMonth=&category=&status=&clinicId=
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const providerId = searchParams.get('providerId')
  const periodMonth = searchParams.get('periodMonth')
  const category = searchParams.get('category')
  const status = searchParams.get('status')
  const clinicId = searchParams.get('clinicId')
  const labId = searchParams.get('labId')
  const unlocked = searchParams.get('unlocked')

  const where: any = {}
  if (providerId) where.providerId = providerId
  if (periodMonth) where.periodMonth = periodMonth
  if (category) where.category = category
  if (status) where.status = status
  if (clinicId) where.clinicId = clinicId
  if (labId) where.labId = labId
  if (unlocked === '1') where.lockedByRunId = null

  // MANAGER scope: only see their clinics
  if (scope === 'my-clinics' && session.clinics && session.clinics.length > 0) {
    where.clinicId = { in: session.clinics }
  }

  const [cases, totals] = await prisma.$transaction([
    prisma.costCase.findMany({
      where,
      orderBy: { orderedAt: 'desc' },
      include: {
        lab: { select: { id: true, name: true } },
        materials: true,
      },
    }),
    prisma.costCase.aggregate({
      where,
      _sum: { finalCost: true, baseCost: true },
      _count: true,
    }),
  ])

  // Count without baseCost
  const unpriced = await prisma.costCase.count({
    where: { ...where, baseCost: null },
  })

  // Group by lab
  const labGroups: Record<string, { count: number; total: number }> = {}
  for (const c of cases) {
    let key: string | null = null
    if (c.lab) {
      key = c.lab.name
    } else if (c.labOther) {
      key = `other:${c.labOther}`
    } else if (c.labId === null) {
      // skip — no lab selected
    }
    if (!key) continue
    if (!labGroups[key]) labGroups[key] = { count: 0, total: 0 }
    labGroups[key].count++
    const fc = c.finalCost ? Number(c.finalCost) : 0
    labGroups[key].total += fc
  }

  // Serialize Decimal fields for JSON
  const serializedCases = cases.map(c => ({
    ...c,
    baseCost: c.baseCost ? Number(c.baseCost) : null,
    discountPct: c.discountPct ? Number(c.discountPct) : null,
    finalCost: c.finalCost ? Number(c.finalCost) : null,
    materials: c.materials.map(m => ({
      ...m,
      unitPriceUsed: Number(m.unitPriceUsed),
      subtotal: Number(m.subtotal),
    })),
  }))

  return jsonNoStore({
    cases: serializedCases,
    summary: {
      total: totals._count,
      totalFinalCost: totals._sum.finalCost ? Number(totals._sum.finalCost) : null,
      totalBaseCost: totals._sum.baseCost ? Number(totals._sum.baseCost) : null,
      unpricedCount: unpriced,
      labGroups,
    },
  })
}

// ============================================================
// POST /api/cost-cases — Create a cost case (LAB / INVISALIGN)
// Roles: OWNER, MANAGER
// Body: { providerId, clinicId, category, patientCode, patientName?,
//         orderedAt, itemType?, labId?, labOrderNo?, dsaName?,
//         baseCost?, discountPct?, receivedAt?, appointmentAt? }
// ============================================================
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  const body = await req.json()
  const {
    providerId, clinicId, category, patientCode, patientName,
    orderedAt, itemType, itemTypeOther, labId, labOther, labOrderNo, dsaName,
    baseCost, discountPct, receivedAt, appointmentAt,
    billExtId, billCode, billItemEleId, // ★ MD-F
  } = body

  if (!providerId || !clinicId || !category || !patientCode || !orderedAt) {
    return NextResponse.json(
      { error: 'providerId, clinicId, category, patientCode, orderedAt are required' },
      { status: 400 }
    )
  }

  if (!['LAB', 'INVISALIGN'].includes(category)) {
    return NextResponse.json({ error: 'IMPLANT 請用 POST /api/cost-cases/implant' }, { status: 400 })
  }

  // Derive periodMonth from orderedAt
  const periodMonth = toHKDateStr(orderedAt).slice(0, 7)

  // ★ Q2: Look up discount from LabMonthlyDiscount table (ignore body discountPct)
  const effectiveLabId = labId || null
  let discountPctNum: number | null = null
  if (effectiveLabId) {
    const d = await prisma.labMonthlyDiscount.findUnique({
      where: { labId_periodMonth: { labId: effectiveLabId, periodMonth } },
      select: { discountPct: true },
    })
    discountPctNum = d ? Number(d.discountPct) : null
  }
  // ★ labOther（Others）冇折扣 —— 要折扣就正式建一個 Lab

  // Compute finalCost
  const baseCostNum = baseCost != null ? Number(baseCost) : null
  let finalCostNum: number | null = null
  if (baseCostNum != null && discountPctNum != null) {
    finalCostNum = Number((baseCostNum * (100 - discountPctNum) / 100).toFixed(2))
  } else if (baseCostNum != null) {
    finalCostNum = baseCostNum
  }

  // If no baseCost, status stays PENDING
  const status = baseCostNum != null ? 'PRICED' : 'PENDING'

  const caseData = await prisma.costCase.create({
    data: {
      providerId,
      clinicId,
      category,
      patientCode,
      patientName: patientName || null,
      orderedAt: new Date(orderedAt),
      itemType: itemType || null,
      itemTypeOther: itemTypeOther || null,
      labId: labId || null,
      labOther: labOther || null,
      labOrderNo: labOrderNo || null,
      dsaName: dsaName || null,
      baseCost: baseCostNum != null ? baseCostNum : null,
      discountPct: discountPctNum != null ? discountPctNum : null,
      finalCost: finalCostNum != null ? finalCostNum : null,
      receivedAt: receivedAt ? new Date(receivedAt) : null,
      appointmentAt: appointmentAt ? new Date(appointmentAt) : null,
      billExtId: billExtId || null,
      billCode: billCode || null,
      billItemEleId: billItemEleId || null,
      source: billExtId ? 'BILL_LINKED' : 'MANUAL',
      status,
      periodMonth,
      createdBy: session.userId,
    },
    include: {
      lab: { select: { id: true, name: true } },
    },
  })

  // Audit log
  await prisma.auditLog.create({
    data: {
      actorId: session.userId,
      action: 'COST_CASE_CREATE',
      entity: 'CostCase',
      entityId: caseData.id,
      clinicId,
      beforeJson: null,
      afterJson: JSON.stringify({
        providerId, clinicId, category, patientCode,
        baseCost: baseCostNum, discountPct: discountPctNum,
        finalCost: finalCostNum, status,
      }),
      notes: `新增成本記錄: ${category} ${patientCode} ${baseCostNum != null ? '$' + baseCostNum : '未有價'} (${periodMonth})`,
    },
  } as any)

  const result = {
    ...caseData,
    baseCost: caseData.baseCost ? Number(caseData.baseCost) : null,
    discountPct: caseData.discountPct ? Number(caseData.discountPct) : null,
    finalCost: caseData.finalCost ? Number(caseData.finalCost) : null,
  }

  return NextResponse.json({ case: result }, { status: 201 })
}

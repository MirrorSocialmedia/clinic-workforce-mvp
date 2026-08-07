export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hkDateStart, hkDateEnd } from '@/lib/hk-date'
import { runWithAudit } from '@/lib/audit-context'
import { requireAuth, applyScopeFilter, isAuthError } from '@/lib/require-auth'

// ============================================================
// GET /api/punches — List punch records with filters
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const employeeId = searchParams.get('employeeId')
  const startDate = searchParams.get('startDate')
  const endDate = searchParams.get('endDate')
  const punchType = searchParams.get('punchType')
  const includeVoided = searchParams.get('includeVoided') === '1'
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1)
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get('pageSize') || '50', 10) || 50))
  const skip = (page - 1) * pageSize

  const where: any = {}

  if (clinicId) where.clinicId = clinicId
  if (employeeId) where.employeeId = employeeId
  if (punchType) where.punchType = punchType

  if (startDate || endDate) {
    where.punchTime = {}
    if (startDate) where.punchTime.gte = hkDateStart(startDate)
    if (endDate) where.punchTime.lte = hkDateEnd(endDate)
  }

  // Data scope filtering
  const sessionClinics = session.clinics ?? []
  if (scope === 'my-clinics' && sessionClinics.length > 0) {
    where.clinicId = { in: sessionClinics }
  }

  const [records, total] = await Promise.all([
    prisma.punchRecord.findMany({
      where: {
        ...where,
        ...(includeVoided ? {} : { void: { is: null } }), // ★ opt-in voided
      },
      include: {
        employee: {
          include: {
            user: { select: { id: true, name: true, phone: true } },
          },
        },
        clinic: { select: { id: true, name: true } },
        corrections: {
          where: { status: 'APPROVED' },
          orderBy: { createdAt: 'asc' },
        },
        void: true, // Include void info for UI
      },
      orderBy: [{ punchTime: 'desc' }, { id: 'asc' }], // ★ unique tiebreaker for stable pagination
      skip,
      take: pageSize,
    }),
    prisma.punchRecord.count({
      where: { ...where, ...(includeVoided ? {} : { void: { is: null } }) },
    }),
  ])

  // Map reviewer userId → name
  const reviewerIds = [...new Set(records.map((p: any) => p.faceReviewedBy).filter(Boolean))] as string[]
  const reviewers = reviewerIds.length
    ? await prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true } })
    : []
  const reviewerName = Object.fromEntries(reviewers.map(u => [u.id, u.name]))
  const out = records.map((p: any) => ({
    ...p,
    faceReviewerName: p.faceReviewedBy ? (reviewerName[p.faceReviewedBy] ?? null) : null,
  }))

  return NextResponse.json(
    { records: out, total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
    { headers: { 'Cache-Control': 'no-store, must-revalidate' } },
  )
}

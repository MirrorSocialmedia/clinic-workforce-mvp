export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/face/review — List FAIL punches awaiting review
// Roles: OWNER, MANAGER
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const items = await prisma.punchRecord.findMany({
    where: { faceStatus: { in: ['FAIL', 'NO_FACE'] }, faceReviewedAt: null },
    include: {
      employee: { include: { user: { select: { name: true } } } },
      clinic: { select: { name: true } },
    },
    orderBy: { punchTime: 'desc' },
  })

  return NextResponse.json(items.map(item => ({
    id: item.id,
    punchTime: item.punchTime,
    employeeName: item.employee.user.name,
    clinicName: item.clinic.name,
    faceStatus: item.faceStatus,
    faceScore: item.faceScore,
    faceLiveness: item.faceLiveness,
    faceFramePath: item.faceFramePath,
    faceReason: item.faceReason,
  })))
}

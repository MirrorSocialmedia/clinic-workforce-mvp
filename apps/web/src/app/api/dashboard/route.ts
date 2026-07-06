export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/dashboard — dashboard data based on role
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  let clinics: any[] = []

  if (scope === 'all') {
    clinics = await prisma.clinic.findMany({
      include: {
        _count: {
          select: {
            users: true,
            employees: true,
            shifts: true,
            punches: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })
  } else {
    clinics = await prisma.clinic.findMany({
      where: { id: { in: session.clinics } },
      include: {
        _count: {
          select: {
            users: true,
            employees: true,
            shifts: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    })
  }

  // Get recent audit logs for non-EMPLOYEE
  let recentAuditLogs: any[] = []
  if (scope !== 'self') {
    const where: any = {}
    if (scope === 'my-clinics' && session.clinics.length > 0) {
      where.clinicId = { in: session.clinics }
    }
    recentAuditLogs = await prisma.auditLog.findMany({
      where,
      include: { actor: { select: { name: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    })
  }

  return NextResponse.json({
    role: session.role,
    clinics,
    recentAuditLogs,
  })
}

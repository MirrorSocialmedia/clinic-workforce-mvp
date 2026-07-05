import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import prisma from '@/lib/prisma'

// GET /api/dashboard — dashboard data based on role
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let clinics: any[] = []

  if (CONFIG.UNRESTRICTED_ROLES.includes(session.role)) {
    // OWNER sees all clinics
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
  } else if (session.role === 'MANAGER' || session.role === 'ACCOUNTANT') {
    // MANAGER/ACCOUNTANT sees only their clinics
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
  } else {
    // EMPLOYEE sees only their clinic info
    clinics = await prisma.clinic.findMany({
      where: { id: { in: session.clinics } },
      orderBy: { name: 'asc' },
    })
  }

  // Get recent audit logs for OWNER/MANAGER/ACCOUNTANT
  let recentAuditLogs: any[] = []
  if (['OWNER', 'MANAGER', 'ACCOUNTANT'].includes(session.role)) {
    const where: any = {}
    if (session.role === 'MANAGER' && session.clinics.length > 0) {
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

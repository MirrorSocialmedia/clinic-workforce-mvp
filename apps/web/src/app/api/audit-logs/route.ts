import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { CONFIG } from '@/lib/config'
import prisma from '@/lib/prisma'

// GET /api/audit-logs — list audit logs (OWNER/MANAGER/ACCOUNTANT only)
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Only OWNER, MANAGER, ACCOUNTANT can view audit logs
  if (!['OWNER', 'MANAGER', 'ACCOUNTANT'].includes(session.role)) {
    return NextResponse.json({ error: 'Forbidden: OWNER/MANAGER/ACCOUNTANT only' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const actorId = searchParams.get('actorId')
  const action = searchParams.get('action')
  const entity = searchParams.get('entity')
  const clinicId = searchParams.get('clinicId')
  const fromDate = searchParams.get('fromDate')
  const toDate = searchParams.get('toDate')
  const page = parseInt(searchParams.get('page') || '1')
  const limit = parseInt(searchParams.get('limit') || '50')

  const where: any = {}

  if (actorId) where.actorId = actorId
  if (action) where.action = action
  if (entity) where.entity = entity
  if (clinicId) where.clinicId = clinicId

  // MANAGER only sees their clinic's audit logs
  if (session.role === 'MANAGER' && session.clinics.length > 0) {
    where.clinicId = { in: session.clinics }
  }

  if (fromDate || toDate) {
    where.createdAt = {}
    if (fromDate) where.createdAt.gte = new Date(fromDate)
    if (toDate) where.createdAt.lte = new Date(toDate)
  }

  const skip = (page - 1) * limit

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { name: true, phone: true, role: true } } },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ])

  return NextResponse.json({
    logs,
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  })
}

// No PUT/DELETE for audit logs — append-only!

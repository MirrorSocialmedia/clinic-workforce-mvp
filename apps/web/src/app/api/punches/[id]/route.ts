export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// ============================================================
// GET /api/punches/[id] — Single punch record + full correction chain
// Roles: OWNER, MANAGER, ACCOUNTANT
// ============================================================
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const id = params.id

  const record = await prisma.punchRecord.findUnique({
    where: { id },
    include: {
      employee: {
        include: {
          user: { select: { id: true, name: true, phone: true } },
        },
      },
      clinic: { select: { id: true, name: true } },
      // All corrections referencing this record (any status)
      corrections: {
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  if (!record) {
    return NextResponse.json({ error: 'Record not found' }, { status: 404 })
  }

  // Build the correction chain
  const chain: any[] = [
    {
      type: 'original',
      id: record.id,
      punchTime: record.punchTime.toISOString(),
      punchType: record.punchType,
      source: record.source,
      tokenValid: record.tokenValid,
      deviceInfo: record.deviceInfo,
      notes: record.notes,
      createdAt: record.createdAt.toISOString(),
    },
  ]

  // Add corrections to the chain
  for (const correction of record.corrections) {
    chain.push({
      type: 'correction',
      id: correction.id,
      correctedTime: correction.correctedTime.toISOString(),
      punchType: correction.punchType,
      reason: correction.reason,
      requestedBy: correction.requestedBy,
      approvedBy: correction.approvedBy,
      status: correction.status,
      createdAt: correction.createdAt.toISOString(),
      updatedAt: correction.updatedAt.toISOString(),
    })
  }

  return NextResponse.json({
    record: {
      id: record.id,
      employeeId: record.employeeId,
      clinicId: record.clinicId,
      punchTime: record.punchTime.toISOString(),
      punchType: record.punchType,
      source: record.source,
      tokenValid: record.tokenValid,
      deviceInfo: record.deviceInfo,
      notes: record.notes,
      createdAt: record.createdAt.toISOString(),
      employee: record.employee,
      clinic: record.clinic,
    },
    chain,
  })
}

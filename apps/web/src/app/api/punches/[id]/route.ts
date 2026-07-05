import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// GET /api/punches/[id] — Single punch record + full correction chain
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const record = await prisma.punchRecord.findUnique({
    where: { id: params.id },
    include: {
      employee: { include: { user: { select: { id: true, name: true, phone: true } } } },
      clinic: { select: { id: true, name: true } },
      corrections: { orderBy: { createdAt: 'asc' } },
    },
  })

  if (!record) return NextResponse.json({ error: 'Record not found' }, { status: 404 })

  const chain: any[] = [{
    type: 'original', id: record.id,
    punchTime: record.punchTime.toISOString(), punchType: record.punchType,
    source: record.source, tokenValid: record.tokenValid,
    deviceInfo: record.deviceInfo, notes: record.notes,
    createdAt: record.createdAt.toISOString(),
  }]

  for (const correction of record.corrections) {
    chain.push({
      type: 'correction', id: correction.id,
      correctedTime: correction.correctedTime.toISOString(),
      punchType: correction.punchType, reason: correction.reason,
      requestedBy: correction.requestedBy, approvedBy: correction.approvedBy,
      status: correction.status,
      createdAt: correction.createdAt.toISOString(),
      updatedAt: correction.updatedAt.toISOString(),
    })
  }

  return NextResponse.json({
    record: {
      id: record.id, employeeId: record.employeeId, clinicId: record.clinicId,
      punchTime: record.punchTime.toISOString(), punchType: record.punchType,
      source: record.source, tokenValid: record.tokenValid,
      deviceInfo: record.deviceInfo, notes: record.notes,
      createdAt: record.createdAt.toISOString(),
      employee: record.employee, clinic: record.clinic,
    },
    chain,
  })
}

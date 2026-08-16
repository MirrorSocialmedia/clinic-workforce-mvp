export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

/** GET /api/apricot/sync/jobs — 列出 jobs */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, req.method, req.url)
  if (isAuthError(auth)) return auth.error

  const jobs = await prisma.apricotSyncJob.findMany({
    orderBy: { startedAt: 'desc' },
    take: 50,
    select: {
      id: true,
      status: true,
      totalClinics: true,
      doneClinics: true,
      paymentsSynced: true,
      billsChecked: true,
      allocRows: true,
      currentStep: true,
      startedAt: true,
      endedAt: true,
      errorMessage: true,
      createdBy: true,
    },
  })

  return NextResponse.json({ jobs })
}

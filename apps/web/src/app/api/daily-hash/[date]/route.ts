export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { getDailyHash, verifyDailyHash } from '@/lib/daily-hash'

// GET /api/daily-hash/[date] — Get/verify daily hash for a specific date
export async function GET(
  req: NextRequest,
  { params }: { params: { date: string } }
) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')
  const verify = searchParams.get('verify') === 'true'

  if (!clinicId) {
    return NextResponse.json({ error: 'clinicId query parameter is required' }, { status: 400 })
  }

  const targetDate = new Date(params.date)
  targetDate.setHours(0, 0, 0, 0)

  if (verify) {
    const result = await verifyDailyHash(clinicId, targetDate)
    return NextResponse.json({ clinicId, date: targetDate.toISOString(), ...result })
  }

  const hash = await getDailyHash(clinicId, targetDate)
  if (!hash) return NextResponse.json({ error: 'Hash not found' }, { status: 404 })

  return NextResponse.json({ hash })
}

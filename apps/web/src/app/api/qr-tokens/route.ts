export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { generateQRToken, cleanupExpiredTokens } from '@/lib/qr-token'

// ============================================================
// GET /api/qr-tokens — Generate a new QR token for the clinic
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const auth = requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')

  if (!clinicId) {
    return NextResponse.json(
      { error: 'clinicId query parameter is required' },
      { status: 400 }
    )
  }

  // Verify clinic access
  if (scope !== 'all' && !session.clinics.includes(clinicId)) {
    return NextResponse.json({ error: 'No access to this clinic' }, { status: 403 })
  }

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } })
  if (!clinic) {
    return NextResponse.json({ error: 'Clinic not found' }, { status: 404 })
  }

  const qrToken = await generateQRToken(clinicId)

  const cleanupCount = parseInt(process.env.QR_TOKEN_CLEANUP_COUNTER || '0')
  if (cleanupCount % 10 === 0) {
    cleanupExpiredTokens().catch(console.error)
  }

  return NextResponse.json({
    success: true,
    token: qrToken.token,
    shortCode: qrToken.shortCode,
    expiresAt: qrToken.expiresAt.toISOString(),
    clinicId,
  })
}

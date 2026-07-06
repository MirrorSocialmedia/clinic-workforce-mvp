export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { verifyToken } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { generateQRToken, cleanupExpiredTokens } from '@/lib/qr-token'

// ============================================================
// GET /api/qr-tokens — Generate a new QR token for the clinic
// Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE
// ============================================================
export async function GET(req: NextRequest) {
  const token = req.cookies.get('session')?.value
  const session = token ? verifyToken(token) : null

  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const clinicId = searchParams.get('clinicId')

  if (!clinicId) {
    return NextResponse.json(
      { error: 'clinicId query parameter is required' },
      { status: 400 }
    )
  }

  // Verify clinic exists
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } })
  if (!clinic) {
    return NextResponse.json({ error: 'Clinic not found' }, { status: 404 })
  }

  // Generate new token
  const qrToken = await generateQRToken(clinicId)

  // Periodic cleanup (every 10th request for simplicity)
  // In production, use a real cron job
  const cleanupCount = parseInt(process.env.QR_TOKEN_CLEANUP_COUNTER || '0')
  if (cleanupCount % 10 === 0) {
    cleanupExpiredTokens().catch(console.error)
  }

  return NextResponse.json({
    success: true,
    token: qrToken.token,
    expiresAt: qrToken.expiresAt.toISOString(),
    clinicId,
  })
}

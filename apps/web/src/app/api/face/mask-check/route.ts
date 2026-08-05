export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { CONFIG } from '@/lib/config'

/**
 * POST /api/face/mask-check — Proxy to face-service /mask endpoint
 * Roles: OWNER, MANAGER, ACCOUNTANT, EMPLOYEE (same as verify-punch)
 * Always returns 200 — never 5xx (fail-open for punch flow)
 * Timeout: 1.2s
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error

  try {
    const fd = await req.formData()
    const frame = fd.get('frame') as File | null
    if (!frame) {
      return NextResponse.json({ masked: false, degraded: true })
    }

    const faceFd = new FormData()
    faceFd.append('file', frame, 'mask-check.jpg')

    const res = await fetch(`${CONFIG.FACE_SERVICE_URL}/mask`, {
      method: 'POST',
      body: faceFd,
      signal: AbortSignal.timeout(1200),
    })

    if (res.ok) {
      const data = await res.json()
      return NextResponse.json({
        masked: data.masked ?? false,
        confidence: data.confidence ?? 0,
        degraded: data.degraded ?? false,
      })
    }

    // Non-200 from face-service → fail-open
    return NextResponse.json({ masked: false, degraded: true })

  } catch {
    // Any error (timeout, network, parse) → fail-open 200
    return NextResponse.json({ masked: false, degraded: true })
  }
}

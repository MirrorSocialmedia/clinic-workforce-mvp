export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { resolveClinicScope } from '@/lib/scope-helpers'
import { prisma } from '@/lib/prisma'

// GET /api/payroll-runs/allowed-clinics
// 回傳當前使用者可以【生成計糧】嘅診所
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session } = auth

  // ★ 同 POST /api/payroll-runs 用同一個範圍判斷
  const allowed = await resolveClinicScope(session, auth.perms ?? [], {
    homeOnly: ['payroll_generate'],
  })

  const clinics = await prisma.clinic.findMany({
    where: allowed === null ? {} : { id: { in: allowed } },
    select: { id: true, name: true, shortName: true },
    orderBy: { name: 'asc' },
  })

  return NextResponse.json({ clinics }, { headers: { 'Cache-Control': 'no-store' } })
}

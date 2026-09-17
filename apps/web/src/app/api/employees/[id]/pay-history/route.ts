export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError, assertClinicAccess } from '@/lib/require-auth'
import { canSeeConfidential } from '@/lib/scope-helpers'

// GET /api/employees/:id/pay-history — pay rule history
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error
  const { session, scope } = auth

  const employee = await prisma.employee.findUnique({ where: { id: params.id } })
  if (!employee) return NextResponse.json({ error: 'Employee not found' }, { status: 404 })

  // ★ IDOR: MANAGER 只可以睇自己店員工嘅薪酬歷史
  const denied = assertClinicAccess(scope, session, employee.homeClinicId)
  if (denied) return denied

  // ★ cwm-p0sec-20260917：保密員工薪酬 —— 同一個 canSeeConfidential helper（坑⑥）
  if (!(await canSeeConfidential(session, auth.perms ?? [], employee))) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const payRules = await prisma.payRule.findMany({
    where: { employeeId: params.id },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
  })

  return NextResponse.json({ payRules })
}

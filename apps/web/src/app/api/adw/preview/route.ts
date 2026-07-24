import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { prisma } from '@/lib/prisma'
import { calculateADW } from '@/lib/adw'

// ============================================================
// GET /api/adw/preview?employeeId=xxx&date=2026-08-01
// Returns ADWResult for the given employee and date
// ============================================================
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, 'GET', req.url)
  if (isAuthError(auth)) return auth.error

  const { searchParams } = new URL(req.url)
  const employeeId = searchParams.get('employeeId')
  const date = searchParams.get('date')

  if (!employeeId) {
    return NextResponse.json({ error: 'employeeId required' }, { status: 400 })
  }

  // Check pay confidentiality: only OWNER can view confidential employees
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { payConfidential: true },
  })

  if (!emp) {
    return NextResponse.json({ error: 'Employee not found' }, { status: 404 })
  }

  if (emp.payConfidential && auth.session.role !== 'OWNER') {
    return NextResponse.json({ error: '無權查看此員工的薪酬資料' }, { status: 403 })
  }

  const specifiedDate = date ? new Date(date + 'T00:00:00+08:00') : new Date()

  const result = await calculateADW(prisma, employeeId, specifiedDate)
  return NextResponse.json(result)
}

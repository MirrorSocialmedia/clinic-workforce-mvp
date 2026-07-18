export const dynamic = 'force-dynamic'
import { requireAuth, isAuthError } from '@/lib/require-auth'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { grantRestDaysForMonth } from '@/lib/payroll-engine'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireAuth(req, 'POST', req.url)
  if (isAuthError(auth)) return auth.error
  if (auth.session.role !== 'OWNER') return NextResponse.json({ error: '僅老闆可執行' }, { status: 403 })

  const emps = await prisma.employee.findMany({ where: { status: 'ACTIVE' } })
  const now = new Date()
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  let count = 0
  for (const e of emps) {
    await grantRestDaysForMonth(e.id, now, prisma)     // 當月
    await grantRestDaysForMonth(e.id, next, prisma)   // 下月
    count++
  }

  return NextResponse.json({ ok: true, employeeCount: count, message: `已補發 ${count} 名員工的當月+下月休息日池` })
}

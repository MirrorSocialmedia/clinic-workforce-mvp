export const dynamic = 'force-dynamic'
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAuth, isAuthError } from '@/lib/require-auth'

// PUT /api/companies/[id] — rename company
// RBAC: OWNER only
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, 'PUT', req.url)
  if (isAuthError(auth)) return auth.error

  try {
    const { id } = await params
    const body = await req.json()
    if (!body.name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }
    const data: Record<string, any> = { name: body.name }
    if (body.logoData !== undefined) data.logoData = body.logoData
    // ★ 2026-08-25：法定名稱（薪俸結算書公司印鑑用）— 留空 = null → PDF 用 name fallback
    if (body.legalName !== undefined) data.legalName = body.legalName?.trim() || null
    // ★ 2026-09-10 cwm-payrollui 拍板⑤：計糧詳情自訂顯示（全公司統一）
    //   只接受已知 key（白名單過濾，防前端亂塞）+ 強制項補回（冇咗認唔到邊行/睇唔到金額）
    if (body.payrollView !== undefined) {
      const CARD_KEYS = ['employeeCount', 'totalBase', 'totalExtra', 'totalDeduction',
        'totalMisc', 'payableExMisc', 'totalPayable', 'totalHours', 'totalOTHours', 'totalLeaveAbsent']
      const COL_KEYS = ['employee', 'clinic', 'payType', 'hours', 'otHours', 'leaveDays',
        'absentDays', 'baseSalary', 'extraIncome', 'deduction', 'sickDeduction', 'misc', 'totalPayable', 'detail']
      const cards = Array.isArray(body.payrollView.cards)
        ? body.payrollView.cards.filter((k: any) => typeof k === 'string' && CARD_KEYS.includes(k)) : []
      const columns = Array.isArray(body.payrollView.columns)
        ? body.payrollView.columns.filter((k: any) => typeof k === 'string' && COL_KEYS.includes(k)) : []
      // ★ 強制項一定要喺
      for (const k of ['totalPayable']) if (!cards.includes(k)) cards.push(k)
      for (const k of ['employee', 'totalPayable', 'detail']) if (!columns.includes(k)) columns.push(k)
      data.payrollViewJson = JSON.stringify({ cards, columns })
    }
    const company = await prisma.company.update({ where: { id }, data })
    return NextResponse.json(company)
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// DELETE /api/companies/[id] — delete company (sets clinic.companyId = NULL)
// RBAC: OWNER only
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, 'DELETE', req.url)
  if (isAuthError(auth)) return auth.error

  try {
    const { id } = await params
    await prisma.company.delete({ where: { id } })
    return NextResponse.json({ success: true })
  } catch {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
